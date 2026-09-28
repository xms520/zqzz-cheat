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
    inject = [inject stringByReplacingOccurrencesOfString:@"@@FLAGS_PATH@@" withString:flags];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@PROBE_PATH@@" withString:probe];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@LOG_PATH@@" withString:jlog];
    inject = [inject stringByReplacingOccurrencesOfString:@"@@PROTO_PATH@@" withString:proto];

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

static int g_kill = 0, g_inv = 0, g_noad = 0, g_spd = 1, g_atkMul = 1;

static void sync_flags(void) {
    NSString *json = [NSString stringWithFormat:
        @"{\"kill\":%d,\"inv\":%d,\"noad\":%d,\"spd\":%d,\"atkMul\":%d}",
        g_kill, g_inv, g_noad, g_spd, g_atkMul];
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

#pragma mark - UI

static UIWindow *g_win = nil;
static UIView   *g_ball = nil;
static UIView   *g_panel = nil;
static UILabel  *g_status = nil;
static UISwitch *g_swKill = nil, *g_swInv = nil, *g_swNoad = nil;
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
        CGFloat w = 268, h = 356;
        CGFloat x = MAX(8, MIN(f.size.width - w - 8, g_ballPos.x - w + 29));
        CGFloat y = MAX(60, MIN(f.size.height - h - 40, g_ballPos.y + 34));
        g_panel = [[UIView alloc] initWithFrame:CGRectMake(x, y, w, h)];
        g_panel.backgroundColor = [UIColor colorWithWhite:0.06 alpha:0.94];
        g_panel.layer.cornerRadius = 14;
        g_panel.layer.borderWidth = 1;
        g_panel.layer.borderColor = [UIColor colorWithWhite:1 alpha:0.14].CGColor;

        UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(14, 10, 200, 24)];
        title.text = @"最强追逐 · 助手";
        title.textColor = [UIColor colorWithRed:1 green:0.78 blue:0.24 alpha:1];
        title.font = [UIFont boldSystemFontOfSize:16];
        [g_panel addSubview:title];

        UIButton *close = [UIButton buttonWithType:UIButtonTypeSystem];
        close.frame = CGRectMake(w - 44, 6, 38, 32);
        [close setTitle:@"✕" forState:UIControlStateNormal];
        [close setTitleColor:[UIColor colorWithWhite:0.7 alpha:1] forState:UIControlStateNormal];
        close.titleLabel.font = [UIFont systemFontOfSize:18];
        [close addTarget:self action:@selector(closePanel) forControlEvents:UIControlEventTouchUpInside];
        [g_panel addSubview:close];

        const CGFloat rows[3] = {48, 90, 132};
        NSArray *names = @[@"秒杀（一击必杀）", @"无敌（我方免伤）", @"免广告（直接领奖）"];
        __strong UISwitch **sws[3] = {&g_swKill, &g_swInv, &g_swNoad};
        SEL sels[3] = {@selector(onKill), @selector(onInv), @selector(onNoad)};
        for (int i = 0; i < 3; i++) {
            UILabel *l = [[UILabel alloc] initWithFrame:CGRectMake(14, rows[i], 190, 30)];
            l.text = names[i];
            l.textColor = [UIColor colorWithWhite:0.94 alpha:1];
            l.font = [UIFont systemFontOfSize:14];
            [g_panel addSubview:l];
            UISwitch *s = [[UISwitch alloc] initWithFrame:CGRectMake(w - 66, rows[i] + 1, 51, 31)];
            s.onTintColor = [UIColor colorWithRed:0.15 green:0.8 blue:0.42 alpha:1];
            *sws[i] = s;
            [s addTarget:self action:sels[i] forControlEvents:UIControlEventValueChanged];
            [g_panel addSubview:s];
        }
        g_status = [[UILabel alloc] initWithFrame:CGRectMake(14, 294, w - 28, 56)];
        g_status.numberOfLines = 4;
        g_status.font = [UIFont systemFontOfSize:10];
        g_status.textColor = [UIColor colorWithWhite:0.65 alpha:1];
        [g_panel addSubview:g_status];

        // 全局变速档位（引擎 Scheduler timeScale）
        UILabel *spdL = [[UILabel alloc] initWithFrame:CGRectMake(14, 174, 74, 26)];
        spdL.text = @"全局变速";
        spdL.textColor = [UIColor colorWithWhite:0.94 alpha:1];
        spdL.font = [UIFont systemFontOfSize:14];
        [g_panel addSubview:spdL];

        g_segSpd = [[UISegmentedControl alloc] initWithItems:@[@"关", @"2x", @"3x", @"5x"]];
        g_segSpd.frame = CGRectMake(92, 174, w - 106, 28);
        g_segSpd.selectedSegmentIndex = 0;
        if (@available(iOS 13.0, *)) g_segSpd.selectedSegmentTintColor = [UIColor colorWithRed:0.20 green:0.52 blue:0.95 alpha:1];
        g_segSpd.tintColor = [UIColor colorWithWhite:1 alpha:0.25];
        [g_segSpd addTarget:self action:@selector(onSpd) forControlEvents:UIControlEventValueChanged];
        [g_panel addSubview:g_segSpd];

        // 倍攻（血量差分放大，主线/副本通用）
        UILabel *atkL = [[UILabel alloc] initWithFrame:CGRectMake(14, 210, 74, 26)];
        atkL.text = @"倍攻";
        atkL.textColor = [UIColor colorWithWhite:0.94 alpha:1];
        atkL.font = [UIFont systemFontOfSize:14];
        [g_panel addSubview:atkL];

        g_segAtk = [[UISegmentedControl alloc] initWithItems:@[@"关", @"2x", @"5x", @"10x", @"100x"]];
        g_segAtk.frame = CGRectMake(92, 210, w - 106, 28);
        g_segAtk.selectedSegmentIndex = 0;
        if (@available(iOS 13.0, *)) g_segAtk.selectedSegmentTintColor = [UIColor colorWithRed:0.85 green:0.30 blue:0.20 alpha:1];
        g_segAtk.tintColor = [UIColor colorWithWhite:1 alpha:0.25];
        [g_segAtk addTarget:self action:@selector(onAtk) forControlEvents:UIControlEventValueChanged];
        [g_panel addSubview:g_segAtk];

        UIButton *passBtn = [UIButton buttonWithType:UIButtonTypeSystem];
        passBtn.frame = CGRectMake(14, 248, w - 28, 38);
        passBtn.backgroundColor = [UIColor colorWithRed:0.72 green:0.22 blue:0.16 alpha:1];
        passBtn.layer.cornerRadius = 9;
        [passBtn setTitle:@"一键通关（上报胜利）" forState:UIControlStateNormal];
        [passBtn setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
        passBtn.titleLabel.font = [UIFont boldSystemFontOfSize:14];
        [passBtn addTarget:self action:@selector(onPass) forControlEvents:UIControlEventTouchUpInside];
        [g_panel addSubview:passBtn];

        UIPanGestureRecognizer *pp = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(panelPan:)];
        [g_panel addGestureRecognizer:pp];
    }
    [self refreshSwitches];
    [self refreshStatus];
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
- (void)onPass {
    // 触发一次 JS 侧 forcePass()（写 flags 里的 pass=1，JS 执行后自行回落）
    NSString *p = doc_path(@"zqzz_flags.json");
    NSString *json = [NSString stringWithFormat:
        @"{\"kill\":%d,\"inv\":%d,\"noad\":%d,\"spd\":%d,\"atkMul\":%d,\"pass\":1}",
        g_kill, g_inv, g_noad, g_spd, g_atkMul];
    [json writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    mlog(@"pass=1 sent (once)");
    // 稍后回落到 0，避免重复触发
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ sync_flags(); });
}
- (void)onAtk {
    NSInteger i = g_segAtk.selectedSegmentIndex;
    if (i < 0) i = 0;
    if (i > 4) i = 4;
    g_atkMul = kAtkVals[i];
    sync_flags();
    mlog(@"atkMul=%d", g_atkMul);
}
- (void)refreshSwitches {
    g_swKill.on = g_kill; g_swInv.on = g_inv; g_swNoad.on = g_noad;
    NSInteger idx = 0;
    for (int i = 0; i < 4; i++) if (kSpdVals[i] == g_spd) idx = i;
    g_segSpd.selectedSegmentIndex = idx;
    NSInteger ai = 0;
    for (int i = 0; i < 5; i++) if (kAtkVals[i] == g_atkMul) ai = i;
    g_segAtk.selectedSegmentIndex = ai;
}
- (void)refreshStatus {
    NSString *probe = read_js_probe();
    g_status.text = [NSString stringWithFormat:@"native kill=%d inv=%d noad=%d spd=%d atk=%d\nJS %@",
                     g_kill, g_inv, g_noad, g_spd, g_atkMul,
                     [probe length] > 150 ? [probe substringToIndex:150] : probe];
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

        UILabel *core = [[UILabel alloc] initWithFrame:CGRectMake(s/2 - s/2*0.82, s/2 - s/2*0.82,
                                                                 s*0.82, s*0.82)];
        core.text = @"改";
        core.textAlignment = NSTextAlignmentCenter;
        core.font = [UIFont boldSystemFontOfSize:20];
        core.textColor = [UIColor whiteColor];
        core.backgroundColor = [UIColor colorWithWhite:0.1 alpha:0.92];
        core.layer.cornerRadius = s/2*0.82;
        core.layer.masksToBounds = YES;
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
