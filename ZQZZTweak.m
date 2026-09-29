// ZQZZTweak.m — 最强追逐 1.0.6 (com.zqzz.zsios) 助手 v1
// 功能：秒杀 / 无敌 / 免广告
//
// 引擎档案（本机逆向实证，非推测部分）
//   Cocos Creator 2.x + jsb(V8) 壳；主二进制 primitiveMan-mobile 16.8MB arm64
//   - 启动脚本 main.js（二进制 __cstring 0x100c6f6ff 处有 "main.js" 字符串）
//   - 脚本读取走 cocos FileUtils::getDataFromFile → fopen（导入符号表含 _fopen/_fread）
//   - bundles：assets/{main,subscript,loginpackage,loginscript,...}/index.js，
//     每个 index.js 顶层执行 `window.__require = <内层 require>`，带跨 bundle 回退链
//   - 战斗结算全在 JS：BattleLogic.frameUpdate → Unit.fight → HpEngine.reduceHp
//   - 广告：ModelAD.watchAD → BuildUtil.watchAD → 渠道 101008(LY_iOS_Game) 无 case
//     分支 → 仅 serviceClassPath 动态加载的原生 SDK 会播广告；
//     月卡/永久卡路径走 ModelAD.getReward → SocketMgr.sendNetMsg(C2S_Player_AdReward)
//
// 注入链
//   1) ctor 读 bundle 内 main.js → 尾部追加 zqzz_inject.js（替换路径占位符）
//      → 写 Documents/zqzz_main.js
//   2) fishhook fopen：凡 basename=="main.js" 且只读模式，重定向到 Documents 副本
//   3) JS 侧 500ms 轮询：__require('HpEngine'/'Unit'/'ModelAD'/'BuildUtil'/'SocketMgr')
//      → 包装伤害/死亡/广告入口；读 Documents/zqzz_flags.json 取开关
//   4) native UI：58pt 彩虹环球 + 面板 3 开关，直接挂游戏 keyWindow 顶层
//      （不用独立 UIWindow —— 复用 GLQX/CJCS 实证结论）
//
// ⚠️ 风险点
//   - fishhook 改写 __DATA 绑定表；若目标二进制被加固（绑定表只读/被篡改）会失败，
//     失败时仅注入不生效，不崩溃（fopen 原样透传）
//   - 伤害放大用 1e9 倍：单帧内若结算溢出仍受 Math.max(...,0) 保护
//   - 无敌同时改写 isDeath/doUnitDeath，避免我方出现"已死但血量满"的畸形状态
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <QuartzCore/QuartzCore.h>
#import <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "fishhook.h"

#pragma mark - 日志

static FILE *g_log = NULL;
static NSString *g_doc = nil;

static void mlog(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void mlog(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    NSLog(@"[ZQZZ] %@", s);
    if (!g_log) {
        if (!g_doc) g_doc = NSHomeDirectory();
        NSString *p = [g_doc stringByAppendingPathComponent:@"Documents/zqzz.log"];
        g_log = fopen(p.UTF8String, "a");
    }
    if (g_log) { fprintf(g_log, "[ZQZZ] %s\n", s.UTF8String); fflush(g_log); }
}

// 悬浮球内嵌头像（96x96 JPEG, base64, 4116 chars）
static const char *kAvatarB64 =
    "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"
    "jnTGcZP/2Q==";

#pragma mark - 路径

static NSString *doc_path(NSString *name) {
    NSString *d = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents"];
    return [d stringByAppendingPathComponent:name];
}

#pragma mark - fishhook：main.js 重定向

static FILE *(*orig_fopen)(const char *, const char *);

static FILE *my_fopen(const char *path, const char *mode) {
    if (path && mode && strchr(mode, 'r') && !strchr(mode, 'w') && !strchr(mode, '+')) {
        const char *slash = strrchr(path, '/');
        const char *base = slash ? slash + 1 : path;
        if (!strcmp(base, "main.js")) {
            // 首次命中打印一次，便于真机取证
            static int once = 0;
            if (!once) { once = 1; mlog(@"fopen redirect hit: %s", path); }
            NSString *inj = doc_path(@"zqzz_main.js");
            if ([[NSFileManager defaultManager] fileExistsAtPath:inj]) {
                FILE *f = orig_fopen(inj.UTF8String, mode);
                if (f) return f;
            }
            mlog(@"⚠️ redirected main.js missing, fallback original");
        }
    }
    return orig_fopen(path, mode);
}

static void install_fopen_hook(void) {
    struct rebinding rb;
    rb.name = "fopen";
    rb.replacement = (void *)my_fopen;
    rb.replaced = (void **)&orig_fopen;
    int r = rebind_symbols(&rb, 1);
    mlog(@"fishhook fopen rebind => %d (0=ok)", r);
}

#pragma mark - 注入 JS 组装

extern const char *zqzz_inject_js(void);   // 由 gen 步骤写入 zqzz_js.c

static BOOL build_injected_main(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *base = [[NSBundle mainBundle] resourcePath];
    NSString *src = [base stringByAppendingPathComponent:@"main.js"];
    if (![fm fileExistsAtPath:src]) {
        // 兜底：部分打包方式下资源直接位于 bundle 根
        base = [[NSBundle mainBundle] bundlePath];
        src = [base stringByAppendingPathComponent:@"main.js"];
    }
    if (![fm fileExistsAtPath:src]) {
        mlog(@"⚠️ bundle main.js not found");
        return NO;
    }
    NSData *raw = [NSData dataWithContentsOfFile:src];
    if (!raw || raw.length < 100) { mlog(@"⚠️ main.js read failed"); return NO; }

    NSString *inject = [NSString stringWithUTF8String:zqzz_inject_js()];
    NSString *flags  = doc_path(@"zqzz_flags.json");
    NSString *probe  = doc_path(@"zqzz_js_probe.txt");
    NSString *jlog   = doc_path(@"zqzz_js.log");
    NSString *proto  = doc_path(@"zqzz_proto.txt");
    NSString *cfg    = doc_path(@"zqzz_cfg.txt");
    inject = [inject stringByReplacingOccurrencesOfString:@"@@FLAGS_PATH@@" withString:flags];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@PROBE_PATH@@" withString:probe];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@LOG_PATH@@" withString:jlog];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@PROTO_PATH@@" withString:proto];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@CFG_PATH@@" withString:cfg];

    NSMutableData *out = [NSMutableData dataWithData:raw];
    [out appendData:[@"\n\n/* ---- ZQZZ injected ---- */\n" dataUsingEncoding:NSUTF8StringEncoding]];
    [out appendData:[inject dataUsingEncoding:NSUTF8StringEncoding]];
    [out appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];

    NSString *dst = doc_path(@"zqzz_main.js");
    BOOL ok = [out writeToFile:dst atomically:YES];
    mlog(@"injected main.js: %luB -> %@ (%@)", (unsigned long)out.length, dst, ok ? @"ok" : @"FAIL");
    return ok;
}

#pragma mark - 开关 + flags 同步

static int g_kill = 0, g_inv = 0, g_noad = 0, g_spd = 1, g_atkMul = 1, g_noSuppress = 1;
static int g_cfgIdle = 0, g_cfgHorse = 0, g_cfgMorale = 0;

static void cfg_set_json(char *out, size_t n) {
    char buf[512]; buf[0] = 0;
    if (g_cfgIdle)   strncat(buf, "\"common_value#5025#value\":9999", sizeof(buf)-strlen(buf)-1);
    if (g_cfgHorse) {
        if (buf[0]) strncat(buf, ",", sizeof(buf)-strlen(buf)-1);
        strncat(buf, "\"common_value#59#value\":99999,\"common_value#61#value\":99999", sizeof(buf)-strlen(buf)-1);
    }
    if (g_cfgMorale) {
        if (buf[0]) strncat(buf, ",", sizeof(buf)-strlen(buf)-1);
        strncat(buf, "\"common_value#42#value\":9999", sizeof(buf)-strlen(buf)-1);
    }
    snprintf(out, n, "{%s}", buf);
}

/* 记录已关闭、需要还原的参数路径（一次性发送） */
static char g_restoreJson[512] = "";

static void restore_add(const char *paths) {
    /* paths: "表#id#字段,表#id#字段" → {"表#id#字段":1,...} */
    if (g_restoreJson[0]) return;
    char tmp[512]; snprintf(tmp, sizeof(tmp), "%s", paths);
    char *save = NULL, *tok = strtok_r(tmp, ",", &save);
    char buf[480]; buf[0] = 0;
    while (tok) {
        if (buf[0]) strncat(buf, ",", sizeof(buf)-strlen(buf)-1);
        strncat(buf, "\"", sizeof(buf)-strlen(buf)-1);
        strncat(buf, tok, sizeof(buf)-strlen(buf)-1);
        strncat(buf, "\":1", sizeof(buf)-strlen(buf)-1);
        tok = strtok_r(NULL, ",", &save);
    }
    snprintf(g_restoreJson, sizeof(g_restoreJson), "{%s}", buf);
}

static void sync_flags(void) {
    char cfgJson[576]; cfg_set_json(cfgJson, sizeof(cfgJson));
    NSString *json = [NSString stringWithFormat:
        @"{\"kill\":%d,\"inv\":%d,\"noad\":%d,\"spd\":%d,\"atkMul\":%d,\"noSuppress\":%d,\"cfgSet\":%s,\"cfgRestore\":%s}",
        g_kill, g_inv, g_noad, g_spd, g_atkMul, g_noSuppress, cfgJson,
        (g_restoreJson[0] ? g_restoreJson : "null")];
    g_restoreJson[0] = 0;
    NSString *p = doc_path(@"zqzz_flags.json");
    NSError *e = nil;
    [json writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:&e];
    if (e) mlog(@"flags write err %@", e.localizedDescription);
}

static NSString *read_js_probe(void) {
    NSString *p = doc_path(@"zqzz_js_probe.txt");
    NSString *s = [NSString stringWithContentsOfFile:p encoding:NSUTF8StringEncoding error:NULL];
    return s ?: @"(no probe yet)";
}

#pragma mark - 头像解码

static UIImage *avatar_image(void) {
    static UIImage *img = nil;
    if (img) return img;
    @try {
        NSString *b64 = [NSString stringWithUTF8String:kAvatarB64];
        b64 = [b64 stringByReplacingOccurrencesOfString:@"\n" withString:@""];
        b64 = [b64 stringByReplacingOccurrencesOfString:@" " withString:@""];
        NSData *d = [[NSData alloc] initWithBase64EncodedString:b64
                                                        options:NSDataBase64DecodingIgnoreUnknownCharacters];
        if (d) img = [UIImage imageWithData:d];
    } @catch (NSException *e) { img = nil; }
    return img;
}

#pragma mark - UI

static UIWindow *g_win = nil;
static UIView   *g_ball = nil;
static UIView   *g_panel = nil;
static UILabel  *g_status = nil;
static UISwitch *g_swKill = nil, *g_swInv = nil, *g_swNoad = nil, *g_swAtk = nil;
static UIButton *g_btnIdle = nil, *g_btnHorse = nil, *g_btnMorale = nil;
static UISegmentedControl *g_segSpd = nil;
static UISegmentedControl *g_segAtk = nil;
static CGPoint   g_ballPos;

static const int kSpdVals[4] = {1, 2, 3, 5};   // 与 JS 侧 SPD 数组必须一致
static const int kAtkVals[5] = {1, 2, 5, 10, 100};  // 攻击倍率档位（1=关）

@interface ZQHelper : NSObject <UIGestureRecognizerDelegate>
@end

@implementation ZQHelper
- (void)ballTap:(UITapGestureRecognizer *)g { 
    if (g_panel.superview) { [g_panel removeFromSuperview]; return; }
    [self openPanel];
}
- (void)ballPan:(UIPanGestureRecognizer *)g {
    UIView *v = g.view;
    CGPoint t = [g translationInView:v.superview];
    CGPoint c = CGPointMake(v.center.x + t.x, v.center.y + t.y);
    CGRect b = v.superview.bounds;
    c.x = MAX(29, MIN(b.size.width - 29, c.x));
    c.y = MAX(60, MIN(b.size.height - 29, c.y));
    v.center = c;
    g_ballPos = c;
    [g setTranslation:CGPointZero inView:v.superview];
}
- (void)openPanel {
    if (!g_win) return;
    if (!g_panel) {
        CGRect f = g_win.bounds;
        CGFloat w = 272, h = 400;
        CGFloat x = MAX(8, MIN(f.size.width - w - 8, g_ballPos.x - w + 29));
        CGFloat y = MAX(60, MIN(f.size.height - h - 40, g_ballPos.y + 34));
        g_panel = [[UIView alloc] initWithFrame:CGRectMake(x, y, w, h)];
        g_panel.backgroundColor = [UIColor colorWithWhite:0.06 alpha:0.95];
        g_panel.layer.cornerRadius = 14;
        g_panel.layer.borderWidth = 1;
        g_panel.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.14].CGColor;

        // 标题
        UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(14, 9, 200, 24)];
        title.text = @"昆哥儿科技";
        title.textColor = [UIColor colorWithRed:1 green:0.78 blue:0.24 alpha:1];
        title.font = [UIFont boldSystemFontOfSize:16];
        [g_panel addSubview:title];

        UIButton *close = [UIButton buttonWithType:UIButtonTypeSystem];
        close.frame = CGRectMake(w - 42, 5, 36, 30);
        [close setTitle:@"✕" forState:UIControlStateNormal];
        [close setTitleColor:[UIColor colorWithWhite:0.7 alpha:1] forState:UIControlStateNormal];
        close.titleLabel.font = [UIFont systemFontOfSize:18];
        [close addTarget:self action:@selector(closePanel) forControlEvents:UIControlEventTouchUpInside];
        [g_panel addSubview:close];

        // ---- 4 个开关（2×2 网格）----
        NSArray *names = @[@"秒杀", @"无敌", @"免广告", @"倍攻"];
        __strong UISwitch **sws[4] = {&g_swKill, &g_swInv, &g_swNoad, &g_swAtk};
        SEL sels[4] = {@selector(onKill), @selector(onInv), @selector(onNoad), @selector(onAtkSw)};
        CGFloat colW = (w - 28) / 2;
        for (int i = 0; i < 4; i++) {
            CGFloat cx = 14 + (i % 2) * (colW + 4);
            CGFloat cy = 38 + (i / 2) * 36;
            UILabel *l = [[UILabel alloc] initWithFrame:CGRectMake(cx, cy + 3, colW - 58, 24)];
            l.text = names[i];
            l.textColor = [UIColor colorWithWhite:0.94 alpha:1];
            l.font = [UIFont systemFontOfSize:13];
            [g_panel addSubview:l];
            UISwitch *sw = [[UISwitch alloc] initWithFrame:CGRectMake(cx + colW - 54, cy, 51, 31)];
            sw.onTintColor = [UIColor colorWithRed:0.15 green:0.8 blue:0.42 alpha:1];
            sw.transform = CGAffineTransformMakeScale(0.86, 0.86);
            *sws[i] = sw;
            [sw addTarget:self action:sels[i] forControlEvents:UIControlEventValueChanged];
            [g_panel addSubview:sw];
        }

        // ---- 全局变速 ----
        UILabel *spdL = [[UILabel alloc] initWithFrame:CGRectMake(14, 116, 62, 24)];
        spdL.text = @"变速";
        spdL.textColor = [UIColor colorWithWhite:0.94 alpha:1];
        spdL.font = [UIFont systemFontOfSize:13];
        [g_panel addSubview:spdL];
        g_segSpd = [[UISegmentedControl alloc] initWithItems:@[@"关", @"2x", @"3x", @"5x"]];
        g_segSpd.frame = CGRectMake(78, 114, w - 92, 28);
        g_segSpd.selectedSegmentIndex = 0;
        if (@available(iOS 13.0, *)) g_segSpd.selectedSegmentTintColor = [UIColor colorWithRed:0.20 green:0.52 blue:0.95 alpha:1];
        g_segSpd.tintColor = [UIColor colorWithWhite:1 alpha:0.25];
        [g_segSpd addTarget:self action:@selector(onSpd) forControlEvents:UIControlEventValueChanged];
        [g_panel addSubview:g_segSpd];

        // ---- 倍攻倍率 ----
        UILabel *atkL = [[UILabel alloc] initWithFrame:CGRectMake(14, 152, 62, 24)];
        atkL.text = @"倍攻值";
        atkL.textColor = [UIColor colorWithWhite:0.94 alpha:1];
        atkL.font = [UIFont systemFontOfSize:13];
        [g_panel addSubview:atkL];
        g_segAtk = [[UISegmentedControl alloc] initWithItems:@[@"2x", @"5x", @"10x", @"100x"]];
        g_segAtk.frame = CGRectMake(78, 150, w - 92, 28);
        g_segAtk.selectedSegmentIndex = 1;
        if (@available(iOS 13.0, *)) g_segAtk.selectedSegmentTintColor = [UIColor colorWithRed:0.85 green:0.30 blue:0.20 alpha:1];
        g_segAtk.tintColor = [UIColor colorWithWhite:1 alpha:0.25];
        [g_segAtk addTarget:self action:@selector(onAtk) forControlEvents:UIControlEventValueChanged];
        [g_panel addSubview:g_segAtk];

        // ---- 配置类功能（3 个开关）----
        UIButton *cfgHead = [UIButton buttonWithType:UIButtonTypeSystem];
        cfgHead.frame = CGRectMake(14, 186, w - 28, 20);
        [cfgHead setTitle:@"— 配置功能（点开启，再点关闭）—" forState:UIControlStateNormal];
        [cfgHead setTitleColor:[UIColor colorWithWhite:0.55 alpha:1] forState:UIControlStateNormal];
        cfgHead.titleLabel.font = [UIFont systemFontOfSize:10];
        cfgHead.userInteractionEnabled = NO;
        [g_panel addSubview:cfgHead];

        NSArray *cnames = @[@"征收(累计时间→9999)", @"座驾(能量→99999)", @"士气(上限→9999)"];
        SEL csels[3] = {@selector(onCfgIdle), @selector(onCfgHorse), @selector(onCfgMorale)};
        __strong UIButton **cbtns[3] = {&g_btnIdle, &g_btnHorse, &g_btnMorale};
        for (int i = 0; i < 3; i++) {
            UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
            b.frame = CGRectMake(14, 210 + i * 36, w - 28, 32);
            b.backgroundColor = [UIColor colorWithRed:0.20 green:0.22 blue:0.28 alpha:1];
            b.layer.cornerRadius = 8;
            [b setTitle:cnames[i] forState:UIControlStateNormal];
            [b setTitleColor:[UIColor colorWithWhite:0.92 alpha:1] forState:UIControlStateNormal];
            b.titleLabel.font = [UIFont boldSystemFontOfSize:12];
            b.tag = i;
            [b addTarget:self action:csels[i] forControlEvents:UIControlEventTouchUpInside];
            *cbtns[i] = b;
            [g_panel addSubview:b];
        }

        // ---- 状态栏 ----
        g_status = [[UILabel alloc] initWithFrame:CGRectMake(14, 320, w - 28, 68)];
        g_status.numberOfLines = 5;
        g_status.font = [UIFont systemFontOfSize:9.5];
        g_status.textColor = [UIColor colorWithWhite:0.62 alpha:1];
        [g_panel addSubview:g_status];

        UIPanGestureRecognizer *pp = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(panelPan:)];
        [g_panel addGestureRecognizer:pp];
    }
    [self refreshSwitches];
    [self refreshStatus];
    [self refreshCfgButtons];
    [g_win addSubview:g_panel];
    [g_win bringSubviewToFront:g_panel];
}
- (void)panelPan:(UIPanGestureRecognizer *)g {
    UIView *v = g.view;
    CGPoint t = [g translationInView:v.superview];
    CGPoint c = CGPointMake(v.center.x + t.x, v.center.y + t.y);
    CGRect b = v.superview.bounds;
    c.x = MAX(v.frame.size.width/2, MIN(b.size.width - v.frame.size.width/2, c.x));
    c.y = MAX(v.frame.size.height/2, MIN(b.size.height - v.frame.size.height/2, c.y));
    v.center = c;
    [g setTranslation:CGPointZero inView:v.superview];
}
- (void)closePanel { [g_panel removeFromSuperview]; }
- (void)onKill { g_kill = g_swKill.isOn ? 1 : 0; sync_flags(); mlog(@"kill=%d", g_kill); }
- (void)onInv  { g_inv  = g_swInv.isOn  ? 1 : 0; sync_flags(); mlog(@"inv=%d", g_inv); }
- (void)onNoad { g_noad = g_swNoad.isOn ? 1 : 0; sync_flags(); mlog(@"noad=%d", g_noad); }
- (void)onSpd {
    NSInteger i = g_segSpd.selectedSegmentIndex;
    if (i < 0) i = 0;
    if (i > 3) i = 3;
    g_spd = kSpdVals[i];
    sync_flags();
    mlog(@"spd=%d (timeScale)", g_spd);
}
- (void)writeCfgSet:(NSString *)jsonTitle {
    NSString *p = doc_path(@"zqzz_flags.json");
    char cfgJson[576]; cfg_set_json(cfgJson, sizeof(cfgJson));
    NSString *json = [NSString stringWithFormat:
        @"{\"kill\":%d,\"inv\":%d,\"noad\":%d,\"spd\":%d,\"atkMul\":%d,\"noSuppress\":%d,\"cfgSet\":%@}",
        g_kill, g_inv, g_noad, g_spd, g_atkMul, g_noSuppress, jsonTitle];
    [json writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    mlog(@"cfgSet sent: %@", jsonTitle);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ sync_flags(); });
}
- (void)cfgTip:(NSString *)msg {
    UIAlertController *al = [UIAlertController alertControllerWithTitle:@"已写入"
        message:[msg stringByAppendingString:@"\n\n（进主线战斗观察；探针 note=cfgOK: 表示写入成功）"]
        preferredStyle:UIAlertControllerStyleAlert];
    [al addAction:[UIAlertAction actionWithTitle:@"知道了" style:UIAlertActionStyleDefault handler:nil]];
    UIViewController *vc = g_win.rootViewController;
    if (vc) [vc presentViewController:al animated:YES completion:nil];
}
- (void)syncFlagsFull { sync_flags(); mlog(@"flags synced noSuppress=%d", g_noSuppress); }
- (void)onCfgIdle {
    g_cfgIdle = !g_cfgIdle;
    if (!g_cfgIdle) restore_add("common_value#5025#value");
    sync_flags(); [self refreshCfgButtons]; mlog(@"cfgIdle=%d", g_cfgIdle);
}
- (void)onCfgHorse {
    g_cfgHorse = !g_cfgHorse;
    if (!g_cfgHorse) restore_add("common_value#59#value,common_value#61#value");
    sync_flags(); [self refreshCfgButtons]; mlog(@"cfgHorse=%d", g_cfgHorse);
}
- (void)onCfgMorale {
    g_cfgMorale = !g_cfgMorale;
    if (!g_cfgMorale) restore_add("common_value#42#value");
    sync_flags(); [self refreshCfgButtons]; mlog(@"cfgMorale=%d", g_cfgMorale);
}
- (void)refreshCfgButtons {
    UIButton *bs[3] = {g_btnIdle, g_btnHorse, g_btnMorale};
    int on[3] = {g_cfgIdle, g_cfgHorse, g_cfgMorale};
    for (int i = 0; i < 3; i++) {
        UIButton *b = bs[i];
        if (!b) continue;
        b.backgroundColor = on[i]
            ? [UIColor colorWithRed:0.13 green:0.55 blue:0.33 alpha:1]
            : [UIColor colorWithRed:0.20 green:0.22 blue:0.28 alpha:1];
        NSString *base = @[@"征收(累计时间→9999)", @"座驾(能量→99999)", @"士气(上限→9999)"][i];
        [b setTitle:(on[i] ? [base stringByAppendingString:@"  ✓"] : base) forState:UIControlStateNormal];
    }
}
- (void)onAtkSw { g_atkMul = g_swAtk.isOn ? (g_segAtk.selectedSegmentIndex >= 0 ? kAtkVals[g_segAtk.selectedSegmentIndex] : 5) : 1; if (!g_swAtk.isOn) g_segAtk.selectedSegmentIndex = 0; sync_flags(); mlog(@"atkMul=%d (switch)", g_atkMul); }
- (void)onAtk {
    NSInteger i = g_segAtk.selectedSegmentIndex;
    if (i < 0) i = 0;
    if (i > 4) i = 4;
    g_atkMul = kAtkVals[i];
    g_swAtk.on = YES;
    sync_flags();
    mlog(@"atkMul=%d", g_atkMul);
}
- (void)refreshSwitches {
    g_swKill.on = g_kill; g_swInv.on = g_inv; g_swNoad.on = g_noad;
    g_swAtk.on = (g_atkMul > 1);
    NSInteger idx = 0;
    for (int i = 0; i < 4; i++) if (kSpdVals[i] == g_spd) idx = i;
    g_segSpd.selectedSegmentIndex = idx;
    NSInteger ai = 0;
    for (int i = 0; i < 5; i++) if (kAtkVals[i] == g_atkMul) ai = i;
    g_segAtk.selectedSegmentIndex = ai;
}
- (void)refreshStatus {
    NSString *probe = read_js_probe();
    NSString *line2 = @"等待游戏数据…";
    if ([probe length] > 0) {
        NSArray *pairs = @[@[@"hp=1", @"血量"], @[@"unit=1", @"单位"], @[@"mad=1", @"广告"],
                           @[@"sch=1", @"变速"], @[@"sup=", @"压制"], @[@"cfgT=", @"配置表"]];
        NSMutableArray *on = [NSMutableArray array];
        for (NSArray *p in pairs) {
            NSRange r = [probe rangeOfString:p[0]];
            if (r.location != NSNotFound) [on addObject:p[1]];
        }
        line2 = [on count] ? [NSString stringWithFormat:@"挂点: %@", [on componentsJoinedByString:@"·"]] : @"挂点未生效";
        NSRange kr = [probe rangeOfString:@"kill="];
        if (kr.location != NSNotFound) {
            NSString *kv = [probe substringFromIndex:kr.location + 5];
            NSRange sp = [kv rangeOfString:@" "];
            if (sp.location != NSNotFound) kv = [kv substringToIndex:sp.location];
            line2 = [NSString stringWithFormat:@"%@ | 秒杀计数%@", line2, kv];
        }
    }
    NSString *l1 = [NSString stringWithFormat:@"秒杀%@ 无敌%@ 免广告%@ 倍攻%@",
                    g_kill ? @"开" : @"关", g_inv ? @"开" : @"关",
                    g_noad ? @"开" : @"关",
                    g_atkMul > 1 ? [NSString stringWithFormat:@"%dx", g_atkMul] : @"关"];
    NSString *l3 = [NSString stringWithFormat:@"变速%@ | 征收%@ 座驾%@ 士气%@",
                    g_spd > 1 ? [NSString stringWithFormat:@"%dx", g_spd] : @"关",
                    g_cfgIdle ? @"开" : @"关", g_cfgHorse ? @"开" : @"关", g_cfgMorale ? @"开" : @"关"];
    /* 改表结果 */
    NSString *l4 = @"";
    if ([probe rangeOfString:@"note=cfgOK:"].location != NSNotFound) l4 = @"配置写入: 成功";
    else if ([probe rangeOfString:@"note=cfgBAD:"].location != NSNotFound) l4 = @"配置写入: 失败";
    else if ([probe rangeOfString:@"note=cfg:"].location != NSNotFound) l4 = @"配置写入: 成功";
    g_status.text = [NSString stringWithFormat:@"%@\n%@\n%@\n%@", l1, l3, line2, l4];
}

@end

static ZQHelper *g_helper = nil;   // ⚠️ 必须实例化，nil target 会静默吞掉 UIControl 事件

static UIWindow *game_window(void) {
    for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
        if (![sc isKindOfClass:[UIWindowScene class]]) continue;
        for (UIWindow *w in ((UIWindowScene *)sc).windows) {
            if (w.isKeyWindow) return w;
        }
    }
    id dele = [UIApplication sharedApplication].delegate;
    if ([dele respondsToSelector:@selector(window)]) {
        UIWindow *w = [dele performSelector:@selector(window)];
        if (w) return w;
    }
    return [UIApplication sharedApplication].keyWindow;
}

static void ensure_overlay(void) {
    if (!g_helper) g_helper = [[ZQHelper alloc] init];
    UIWindow *w = game_window();
    if (!w) return;
    g_win = w;
    if (!g_ball) {
        CGRect b = w.bounds;
        CGFloat s = 58;
        g_ballPos = CGPointMake(b.size.width - 44, 140);
        g_ball = [[UIView alloc] initWithFrame:CGRectMake(g_ballPos.x - s/2, g_ballPos.y - s/2, s, s)];
        g_ball.backgroundColor = [UIColor clearColor];
        g_ball.layer.shadowColor = [UIColor blackColor].CGColor;
        g_ball.layer.shadowOpacity = 0.5;
        g_ball.layer.shadowRadius = 6;
        g_ball.layer.shadowOffset = CGSizeMake(0, 2);

        CAGradientLayer *ring = [CAGradientLayer layer];
        ring.frame = g_ball.bounds;
        ring.type = kCAGradientLayerConic;
        ring.startPoint = CGPointMake(0.5, 0.5);
        ring.endPoint = CGPointMake(0.5, 0.0);
        ring.colors = @[(id)[UIColor colorWithRed:0.00 green:0.92 blue:1.00 alpha:1].CGColor,
                        (id)[UIColor colorWithRed:0.42 green:0.32 blue:1.00 alpha:1].CGColor,
                        (id)[UIColor colorWithRed:1.00 green:0.20 blue:0.42 alpha:1].CGColor,
                        (id)[UIColor colorWithRed:1.00 green:0.65 blue:0.10 alpha:1].CGColor,
                        (id)[UIColor colorWithRed:0.10 green:0.90 blue:0.50 alpha:1].CGColor,
                        (id)[UIColor colorWithRed:0.00 green:0.92 blue:1.00 alpha:1].CGColor];
        CAShapeLayer *mask = [CAShapeLayer layer];
        mask.path = [UIBezierPath bezierPathWithArcCenter:CGPointMake(s/2, s/2) radius:s/2
                                                  startAngle:0 endAngle:M_PI*2 clockwise:YES].CGPath;
        mask.fillRule = kCAFillRuleEvenOdd;
        UIBezierPath *p = [UIBezierPath bezierPathWithArcCenter:CGPointMake(s/2, s/2) radius:s/2
                                                        startAngle:0 endAngle:M_PI*2 clockwise:YES];
        [p appendPath:[UIBezierPath bezierPathWithArcCenter:CGPointMake(s/2, s/2) radius:s/2*0.82
                                                    startAngle:0 endAngle:M_PI*2 clockwise:YES]];
        mask.path = p.CGPath;
        ring.mask = mask;
        [g_ball.layer addSublayer:ring];

        UIImage *av = avatar_image();
        CGFloat inner = s/2*0.82;
        UIView *core;
        if (av) {
            UIImageView *iv = [[UIImageView alloc] initWithFrame:CGRectMake(s/2 - inner, s/2 - inner, inner*2, inner*2)];
            iv.image = av;
            iv.contentMode = UIViewContentModeScaleAspectFill;
            iv.layer.cornerRadius = inner;
            iv.layer.masksToBounds = YES;
            iv.backgroundColor = [UIColor clearColor];
            core = iv;
        } else {
            UILabel *lb = [[UILabel alloc] initWithFrame:CGRectMake(s/2 - inner, s/2 - inner, inner*2, inner*2)];
            lb.text = @"改";
            lb.textAlignment = NSTextAlignmentCenter;
            lb.font = [UIFont boldSystemFontOfSize:20];
            lb.textColor = [UIColor whiteColor];
            lb.backgroundColor = [UIColor colorWithWhite:0.1 alpha:0.92];
            lb.layer.cornerRadius = inner;
            lb.layer.masksToBounds = YES;
            core = lb;
        }
        [g_ball addSubview:core];
        [g_ball addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:g_helper action:@selector(ballTap:)]];
        UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:g_helper action:@selector(ballPan:)];
        [g_ball addGestureRecognizer:pan];
        g_ball.userInteractionEnabled = YES;
    }
    if (g_ball.superview != w) {
        [w addSubview:g_ball];
        mlog(@"ball attached to window %.0fx%.0f", w.bounds.size.width, w.bounds.size.height);
    } else {
        [w bringSubviewToFront:g_ball];
    }
    if (g_panel.superview == w) [w bringSubviewToFront:g_panel];
}

#pragma mark - 启动

__attribute__((constructor)) static void zqzz_ctor(void) {
    mlog(@"ctor: ZQZZTweak v1 (最强追逐 1.0.6)");
    sync_flags();
    build_injected_main();
    install_fopen_hook();

    dispatch_async(dispatch_get_main_queue(), ^{
        [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *t) {
            ensure_overlay();
            [g_helper refreshStatus];
        }];
        mlog(@"ui tick scheduled");
    });
}
