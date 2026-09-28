/* ============================================================================
 * ZQZZ runtime v1  — 最强追逐(com.zqzz.zsios) 助手 JS 层
 * 注入方式：native fishhook 拦截 main.js 读取，在文件尾部追加本脚本
 *
 * 生效原理（本机逆向实证）
 *   - 引擎 Cocos Creator 2.x + jsb(V8)。每个 bundle 的 index.js 顶层执行
 *     `window.__require = <IIFE 返回的内层函数>`，内层函数带跨 bundle 回退链，
 *     故 window.__require('HpEngine'|'Unit'|'ModelAD'|'SocketMgr'…) 可直接取到
 *     已实例化模块的 exports（命中缓存，不重复执行）。
 *   - 战斗结算全在 JS：BattleLogic.frameUpdate → Unit.fight → Bear → 
 *     HurtBear.doUnit → HpEngine.reduceHp(frameId, atkId, hurt, isLinkHurt,
 *     funcId, ignoreShield, isCanRevive)   —— this 为【受击方】
 *     reduceHp 内部：this.unit.unitBuffs.haveBuff(InvincibleBuff) → 跳过；否则
 *     this.unit.defGroup.addAtkHurt(...) → reduceHpForHurt(hurt) → 死亡判定
 *   - 广告入口（JS 层，全渠道）
 *     ModelAD.watchAD(id,param)  ← 各 UI 统一入口
 *       ├ 有月卡/永久卡 → ModelAD.getReward → sendNetMsg(C2S_Player_AdReward) 直接发奖
 *       └ 否则 → BuildUtil.watchAD → switch(BuilderChannel)
 *            渠道 101008(LY_iOS_Game) 【无 case】→ 原生不播广告（实证：
 *            project.json 无 serviceClassPath 字段 → loadSDKClass 循环不执行；
 *            NativeOcClass 类方法表 14 个方法中无任何广告方法）
 *     另有 ADUtils.showRewardAd / iOSUtils.loadRewardVideoAd / LYUtils.playAD /
 *     chSDK.showRewardAd 四个平台分支实现（本次一并包装，覆盖全部渠道）
 *   - ⚠️ 客户端防破解点：window.onADCallBack 中「本次广告用时 = now-sendAdTime
 *     必须 > 2 秒，否则 console 打印『判定为破解包』」。故直接发奖必须延时 ≥2s。
 *
 *   - 全局变速（引擎级，非改战斗参数）
 *     cc.Director.mainLoop(t) 里：this.calculateDeltaTime(t) → e=this._deltaTime
 *     → this._scheduler.update(e)，注意传入的是【未缩放】dt；而
 *     cc.Scheduler.prototype.update 内部：if (1 !== this._timeScale) t *= this._timeScale
 *     → 作用于全部 scheduler 目标（战斗模拟 tick / cc.tween / cc.director 定时器），
 *     且 _scheduler.update 在 render 之前，因此逻辑与表现一起变速。
 *     入口：cc.director.getScheduler().setTimeScale(N)。
 *     （对比：游戏自带的 setFightSpeed 只改 this.battleSpeed，仅影响
 *      gameBattleMgr/pveBattleMgr/skillBattleMgr 的 tick 与 getFlyTime，
 *      是"官方 2 倍速"级别的受限变速，故本项目走引擎 scheduler。）
 *
 * 占位符（native 注入时替换为真实绝对路径）
 *   @@FLAGS_PATH@@ / @@PROBE_PATH@@ / @@LOG_PATH@@
 * ==========================================================================*/
(function () {
  if (window.__ZQZZ__) return;

  var FLAGS = "@@FLAGS_PATH@@";
  var PROBE = "@@PROBE_PATH@@";
  var LOGF  = "@@LOG_PATH@@";

  var SPD = [1, 2, 3, 5];   // 可选倍率（1=关）；S.spd 保存目标倍率本身
  var S = window.__ZQZZ__ = {
    kill: 0, inv: 0, noad: 0, spd: 1, cur: 1, inst: 0,
    writable: "", hp: 0, unit: 0, mad: 0, sock: 0, bu: 0, aux: 0, sch: 0, rplHook: 0,
    killHits: 0, invBlocks: 0, seen: "", note: "boot", log: ""
  };

  /* 诊断：记录战斗驱动来源，用于区分"本地模拟"与"服务端战报回放"
     - sim : BattleLogic.frameUpdate 被调用的次数（本地模拟在跑）
     - rpl : pveBattleMgr.frameUpdate 被调用的次数（服务端战报回放在跑）
     - mtype: 最近一次 ConfigReader.loadMission 的 missionType
     - skip : 最近一次 loadMission 的 isSkipMode
  */
  var D = window.__ZQZZ_D__ = { sim: 0, rpl: 0, mtype: -1, skip: 0, simFrames: 0, rplFrames: 0 };
  S.diag = "";

  function fs() { try { return jsb.fileUtils; } catch (e) { return null; } }

  function log(s) {
    S.log = (S.log + "[" + Date.now() + "] " + s + "\n").slice(-3000);
    var f = fs(); if (!f) return;
    try { f.writeStringToFile(S.log, LOGF); } catch (e) {}
  }

  function writeProbe() {
    var f = fs(); if (!f) return;
    var t = "ver=v1 inst=" + S.inst + " kill=" + S.kill + " inv=" + S.inv + " noad=" + S.noad +
            " spd=" + S.spd + " cur=" + S.cur +
            " hp=" + S.hp + " unit=" + S.unit + " mad=" + S.mad + " sock=" + S.sock +
            " bu=" + S.bu + " aux=" + S.aux + " sch=" + S.sch + " rplHook=" + S.rplHook +
            " kh=" + S.killHits + " ib=" + S.invBlocks +
            " sim=" + D.sim + " rpl=" + D.rpl + " mtype=" + D.mtype + " skip=" + D.skip +
            " wr=" + S.writable + " seen=" + S.seen + " note=" + S.note;
    try { f.writeStringToFile(t, PROBE); } catch (e) {}
  }

  function readFlags() {
    var f = fs(); if (!f) return;
    var t = "";
    var c = [FLAGS, (S.writable || "") + "zqzz_flags.json", "zqzz_flags.json"];
    for (var i = 0; i < c.length && !t; i++) { try { t = f.getStringFromFile(c[i]); } catch (e) {} }
    if (!t) return;
    try {
      var j = JSON.parse(t);
      S.kill = j.kill ? 1 : 0; S.inv = j.inv ? 1 : 0; S.noad = j.noad ? 1 : 0;
      /* spd = 目标倍率本身（1/2/3/5），未知值安全回退 1 */
      var v = Number(j.spd) || 1;
      S.spd = (SPD.indexOf(v) >= 0) ? v : 1;
    } catch (e) {}
  }

  /* ---------- 模块解析（带结果记录，便于真机取证） ----------
     ⚠️ 只在成功时缓存：bundle 是异步加载的（HpEngine 在 subscript bundle，
     晚于 main.js 就绪），失败必须留待下一轮重试。
     ⚠️⚠️ 模块导出有【两种形态】，必须都兼容（实测）：
       具名：o.HpEngine = u / o.UnitGroup = m / o.BattleLogic = _ /
             o.pveBattleMgr = k / o.pvpBattleMgr = S / o.gameBattleMgr = D /
             o.ConfigReader = N / o.SettingManager = m / o.mainNetCode = n
       默认：o.default = C（ModelAD / BuildUtil / iOSUtils / ADUtils / LYUtils /
             SocketMgr / skillBattleMgr / pveVioFightMgr / chSDK …）
     早期版本统一按 .default 取 → pveBattleMgr 等永远 undefined（补丁静默失效）。 */
  var mcache = {};
  function req(n) {
    if (mcache[n] !== undefined) return mcache[n];
    var r = null;
    try { if (typeof window.__require === "function") r = window.__require(n); } catch (e) { r = null; }
    if (r) { mcache[n] = r; log("req(" + n + ") ok"); }
    return r;
  }

  /* 取模块内的"构造器/类"：优先同名具名导出，再回退 default */
  function ctor(exports, name) {
    if (!exports) return null;
    if (name && typeof exports[name] === "function") return exports[name];
    if (typeof exports.default === "function") return exports.default;
    return null;
  }

  /* 取模块内的单例（形如 X.I） */
  function singleton(exports, name) {
    var C = ctor(exports, name);
    if (C && C.I) return C.I;
    if (exports && exports.I) return exports.I;
    return null;
  }

  /* 取模块内的普通对象/表（mainNetCode 等） */
  function table(exports, name) {
    if (!exports) return null;
    if (name && exports[name] && typeof exports[name] === "object") return exports[name];
    if (exports.default && typeof exports.default === "object") return exports.default;
    return null;
  }

  var lastClaim = 0, pendingTimer = null;

  /* 直接发奖：⚠️ 客户端检测「广告用时必须 > 2 秒」，故延时 2.2s 再发请求 */
  function directReward(id, param, tag) {
    var smI = singleton(req("SocketMgr"), "SocketMgr");
    var nc = table(req("mainNetCode"), "mainNetCode");
    if (!(smI && nc && nc.C2S_Player_AdReward)) {
      S.note = "ad:no-socket id=" + id; return false;
    }
    var o = param || {}; o.id = id;
    if (pendingTimer) clearTimeout(pendingTimer);
    S.note = "ad:pending(2.2s) " + tag + " id=" + id;
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      try {
        smI.sendNetMsg(nc.C2S_Player_AdReward, o);
        S.note = "ad:reward-sent " + tag + " id=" + id;
        log("ad " + tag + " id=" + id + " -> reward sent (no video)");
      } catch (e) { S.note = "ad:send-err:" + e; }
    }, 2200);
    return true;
  }

  var AD_OK = { code: 200, isEnded: true, msg: "广告正常播放结束" };

  /* ---------- 秒杀 / 无敌：HpEngine + Unit ---------- */
  function isMine(u) {
    try { return !!(u && u.myGroup && u.myGroup.isMyGroup); } catch (e) { return false; }
  }

  function hookBattle() {
    var hpMod = req("HpEngine"), unitMod = req("Unit"), ugMod = req("UnitGroup");
    var Hp = ctor(hpMod, "HpEngine"), Unit = ctor(unitMod, "Unit"), UG = ctor(ugMod, "UnitGroup");
    if (!Hp || !Hp.prototype || !Unit || !Unit.prototype) return;

    if (!(Hp.prototype.reduceHp && Hp.prototype.reduceHp.__zq === 1)) {
      var oReduce = Hp.prototype.reduceHp,
          oHurt   = Hp.prototype.reduceHpForHurt,
          oBehead = Hp.prototype.doBeheaderKill;

      Hp.prototype.reduceHp = function (t, e, o, r, s, d, u) {
        var mine = isMine(this.unit);
        try {
          if (mine && S.inv) {                        /* 我方免伤：hurt 置 0 */
            S.invBlocks++;
            var res = oReduce.call(this, t, e, 0, r, s, d, u);
            try { this.hp = Math.max(this.hp, this.unit.getMaxHp()); } catch (x) {}
            return res;
          }
          if (!mine && S.kill && o > 0) {              /* 敌方受击放大 → 秒杀 */
            S.killHits++;
            o = o * 1e9;
          }
        } catch (x) {}
        return oReduce.call(this, t, e, o, r, s, d, u);
      };
      Hp.prototype.reduceHp.__zq = 1;

      /* DOT / 持续掉血 / 献祭通道（绕过 reduceHp 的直接扣血） */
      Hp.prototype.reduceHpForHurt = function (t) {
        if (isMine(this.unit) && S.inv) {
          try { this.hp = Math.max(this.hp, this.unit.getMaxHp()); } catch (x) {}
          return;
        }
        return oHurt.call(this, t);
      };
      Hp.prototype.reduceHpForHurt.__zq = 1;

      /* 斩首技能：无视血量直接击杀 */
      Hp.prototype.doBeheaderKill = function (t, e) {
        if (isMine(this.unit) && S.inv) return;
        return oBehead.call(this, t, e);
      };
      Hp.prototype.doBeheaderKill.__zq = 1;
      S.hp = 1;
    } else { S.hp = 1; }

    if (!(Unit.prototype.isDeath && Unit.prototype.isDeath.__zq === 1)) {
      var oDeath = Unit.prototype.isDeath, oUnitDeath = Unit.prototype.doUnitDeath;

      Unit.prototype.isDeath = function () {
        if (S.inv && isMine(this)) return false;
        return oDeath.call(this);
      };
      Unit.prototype.isDeath.__zq = 1;

      Unit.prototype.doUnitDeath = function (t, e, o) {
        if (S.inv && isMine(this)) {
          try { this.hpEngine.hp = this.getMaxHp(); } catch (x) {}
          return;
        }
        return oUnitDeath.call(this, t, e, o);
      };
      Unit.prototype.doUnitDeath.__zq = 1;
      S.unit = 1;
    } else { S.unit = 1; }

    /* ---------- UnitGroup 级（覆盖服务端战报回放 / 直接改血路径） ----------
       副本(pveBattleMgr)不走 HpEngine.reduceHp，而是：
         - resetUnitGroupHp: 直接 a.initHp = Math.min(a.initHp, e)  → 绕过伤害系统
         - UnitGroup.tankAllDeath / checkEndUnit: setInitHp(0)     → 直接置零
       故在 UnitGroup 上补一层"我方不死"兜底。 */
    if (UG && UG.prototype) {
      if (!(UG.prototype.isAllDead && UG.prototype.isAllDead.__zq === 1)) {
        var oAllDead = UG.prototype.isAllDead;
        UG.prototype.isAllDead = function () {
          try { if (S.inv && this.isMyGroup) return false; } catch (x) {}
          return oAllDead.call(this);
        };
        UG.prototype.isAllDead.__zq = 1;
      }
      if (!(UG.prototype.tankAllDeath && UG.prototype.tankAllDeath.__zq === 1)) {
        var oTankAll = UG.prototype.tankAllDeath;
        UG.prototype.tankAllDeath = function (t) {
          try { if (S.inv && this.isMyGroup) return; } catch (x) {}
          return oTankAll.call(this, t);
        };
        UG.prototype.tankAllDeath.__zq = 1;
      }
      if (!(UG.prototype.getLifeUnit && UG.prototype.getLifeUnit.__zq === 1)) {
        var oLife = UG.prototype.getLifeUnit;
        UG.prototype.getLifeUnit = function () {
          /* 无敌时：我方始终至少返回"未死亡"的单位集合，避免 isDeath 被战报改写影响判定 */
          var r = oLife.call(this);
          try {
            if (S.inv && this.isMyGroup && r.length === 0 && this.units && this.units.length > 0) return this.units.slice();
          } catch (x) {}
          return r;
        };
        UG.prototype.getLifeUnit.__zq = 1;
      }
    }
  }

  /* ---------- 战报回放路径（副本）：拦截服务端下发的我方血量 ----------
     pveBattleMgr.frameUpdate 每帧对 Hurt/RecoverHp/Revive 事件调
       resetUnitGroupHp(p.id, p.hp)
     内部：a.initHp = Math.min(a.initHp, e)   ← 绕过伤害系统直接改血
     单位 id 规则：id < 10 → 我方(atk)，否则敌方(def)（见其 setGroupUnit/resetUnitDead）
     无敌开启时：我方血量一律不改（保持满血）。
     秒杀开启时：不处理（副本胜负由服务端战报决定，改血不影响结果，见文件尾说明）。 */
  function hookReport() {
    var keys = ["pveBattleMgr", "pvpBattleMgr", "gameBattleMgr", "skillBattleMgr", "pveVioFightMgr"];
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      var m = req(keys[i]);
      var C = ctor(m, keys[i]);
      if (!C || !C.prototype) continue;

      if (C.prototype.resetUnitGroupHp && C.prototype.resetUnitGroupHp.__zq !== 1) {
        var oRst = C.prototype.resetUnitGroupHp;
        C.prototype.resetUnitGroupHp = function (id, hp) {
          D.rpl++;
          try { if (S.inv && id < 10) return; } catch (x) {}
          return oRst.call(this, id, hp);
        };
        C.prototype.resetUnitGroupHp.__zq = 1;
        log("report hook " + keys[i] + ".resetUnitGroupHp");
        n++;
      } else if (C.prototype.resetUnitGroupHp) { n++; }
      if (C.prototype.setGroupUnit && C.prototype.setGroupUnit.__zq !== 1) {
        var oSet = C.prototype.setGroupUnit;
        C.prototype.setGroupUnit = function (t) {
          var r = oSet.call(this, t);
          try {
            if (S.inv && this.groupUnit && this.groupUnit.atk && this.groupUnit.atk.units) {
              var mine = this.groupUnit.atk.units;
              for (var k in mine) {
                var u = mine[k];
                if (u && u.setting) {
                  var mx = u.setting.maxHp || u.setting.initHp || 0;
                  if (mx > 0) {
                    u.setting.initHp = mx;
                    if (u.hpEngine) u.hpEngine.hp = mx;
                  }
                }
              }
            }
          } catch (e2) {}
          return r;
        };
        C.prototype.setGroupUnit.__zq = 1;
        n++;
      } else if (C.prototype.setGroupUnit) { n++; }
    }
    if (n > S.rplHook) S.rplHook = n;
  }

  /* ---------- 免广告 ----------
     ⚠️ 关键：这些方法一律定义在【构造器的 prototype】上（实证 grep）：
       ModelAD.prototype.watchAD / ModelAD.prototype.getAdInfo
       iOSUtils.prototype.loadRewardVideoAd
       ADUtils.prototype.showRewardAd
       LYUtils.prototype.playAD
       chSDK.showRewardAd（唯一一个静态）
     若打在实例/对象本身，实例方法会走原型，补丁静默失效。 */
  function patchMethod(obj, proto, key, maker, tag) {
    if (obj && obj[key] && obj[key].__zq === 1) return true;
    if (proto && proto[key] && proto[key].__zq === 1) return true;
    var owner = null, fn = null;
    if (obj && typeof obj[key] === "function") { owner = obj; fn = obj[key]; }
    else if (proto && typeof proto[key] === "function") { owner = proto; fn = proto[key]; }
    if (!owner) return false;
    var nf = maker(fn);
    nf.__zq = 1;
    owner[key] = nf;
    log("ad hook " + tag + "." + key + " @" + (owner === proto ? "proto" : "static"));
    return true;
  }

  function defRO(target, key, getter) {
    if (!target) return false;
    try {
      Object.defineProperty(target, key, { get: getter, set: function () {}, configurable: true });
      return true;
    } catch (e) { try { target[key] = getter(); return true; } catch (e2) { return false; } }
  }

  function hookAd() {
    var n = 0;

    /* 1) ModelAD —— 全 UI 统一入口（prototype！） */
    var MA = req("ModelAD");
    var MAD = ctor(MA, "ModelAD");
    var MADp = MAD && MAD.prototype;
    if (MAD) {
      if (patchMethod(MAD, MADp, "watchAD", function (o) {
        return function (id, param) {
          if (!S.noad) return o.call(this, id, param);
          var now = Date.now();
          if (now - lastClaim < 2500) { S.note = "ad:throttled id=" + id; return; }
          lastClaim = now;
          if (directReward(id, param, "ModelAD.watchAD")) return;
          return o.call(this, id, param);
        };
      }, "ModelAD")) S.mad = 1;

      if (patchMethod(MAD, MADp, "getAdInfo", function (o) {
        return function (id) {
          if (!S.noad) return o.call(this, id);
          return { canWatch: true, cdEndTime: 0, lastCount: 999, maxCount: 999, adId: id };
        };
      }, "ModelAD")) n++;

      /* 静态门禁：月卡判定 || BuildUtil.IsOpenRewardVideo */
      defRO(MAD, "IsOpenRewardVideo", function () { return true; });
    }

    /* 2) BuildUtil 原型上的渠道开关（wxAd funcs 位） */
    var BU = ctor(req("BuildUtil"), "BuildUtil");
    if (BU && BU.prototype && defRO(BU.prototype, "IsOpenRewardVideo", function () { return true; })) S.bu = 1;

    /* 3) 各平台分支实现（覆盖非 iOS 渠道，并兜住服务端动态开关） */
    var iOSU = ctor(req("iOSUtils"), "iOSUtils");
    if (iOSU && patchMethod(iOSU, iOSU.prototype, "loadRewardVideoAd", function (o) {
        return function (cb, adid) {
          if (!S.noad) return o.call(this, cb, adid);
          S.note = "ad:iOSUtils bypass adid=" + adid;
          if (typeof cb === "function") setTimeout(function () { try { cb(); } catch (e) {} }, 2200);
        };
      }, "iOSUtils")) n++;

    var ADU = ctor(req("ADUtils"), "ADUtils");
    if (ADU && patchMethod(ADU, ADU.prototype, "showRewardAd", function (o) {
        return function () {
          if (!S.noad) return o.apply(this, arguments);
          S.note = "ad:ADUtils showRewardAd auto-ok";
          return Promise.resolve(AD_OK);
        };
      }, "ADUtils")) n++;

    var chS = req("chSDK");
    if (chS && patchMethod(chS, chS && chS.prototype, "showRewardAd", function (o) {
        return function () {
          if (!S.noad) return o.apply(this, arguments);
          S.note = "ad:chSDK showRewardAd auto-ok";
          return Promise.resolve(AD_OK);
        };
      }, "chSDK")) n++;

    var LY = ctor(req("LYUtils"), "LYUtils");
    if (LY && patchMethod(LY, LY.prototype, "playAD", function (o) {
        return function (cb, adid, param) {
          if (!S.noad) return o.call(this, cb, adid, param);
          S.note = "ad:LYUtils playAD bypass";
          if (typeof cb === "function") setTimeout(function () { try { cb(); } catch (e) {} }, 100);
        };
      }, "LYUtils")) n++;

    S.aux = n;

    var smMod = req("SocketMgr");
    try { S.sock = singleton(smMod, "SocketMgr") ? 1 : 0; } catch (e) {}
  }

  /* ---------- 全局变速（引擎 Scheduler timeScale，见文件头说明） ---------- */
  function applySpeed() {
    var want = S.spd || 1;
    var sch = null;
    try { sch = cc.director.getScheduler(); } catch (e) { sch = null; }
    if (!sch || typeof sch.setTimeScale !== "function") return;
    S.sch = 1;
    if (S.cur === want) return;
    try {
      sch.setTimeScale(want);
      // 同步官方 2 倍速开关的 UI 图标状态（纯表现层，不改逻辑）
      try {
        var inst = singleton(req("SettingManager"), "SettingManager");
        if (inst && typeof inst.setFightSpeed === "function") inst.setFightSpeed(want > 1);
      } catch (e) {}
      S.cur = want;
      log("timeScale -> " + want);
    } catch (e) { S.note = "speed-err:" + e; }
  }

  /* ---------- 诊断：区分本地模拟 / 服务端战报回放 ---------- */
  function hookDiag() {
    var BLm = req("BattleLogic");
    var BL = ctor(BLm, "BattleLogic");
    if (BL && BL.prototype && BL.prototype.frameUpdate && BL.prototype.frameUpdate.__zqd !== 1) {
      var oB = BL.prototype.frameUpdate;
      BL.prototype.frameUpdate = function (t) {
        D.sim++; D.simFrames = (D.simFrames + 1) % 1e6;
        return oB.call(this, t);
      };
      BL.prototype.frameUpdate.__zqd = 1;
      log("diag: BattleLogic.frameUpdate hooked (本地模拟)");
    } else if (BL && BL.prototype) { D.sim = D.sim || 0; }

    var CRm = req("ConfigReader");
    var CR = ctor(CRm, "ConfigReader");
    if (CR && CR.prototype && CR.prototype.loadMission && CR.prototype.loadMission.__zqd !== 1) {
      var oL = CR.prototype.loadMission;
      CR.prototype.loadMission = function (t) {
        var r;
        try {
          D.mtype = (t && t.type) || -1;
          D.id = (t && t.id) || -1;
        } catch (e) {}
        r = oL.call(this, t);
        try { D.skip = this.isSkipMode ? 1 : 0; } catch (e) {}
        log("loadMission type=" + D.mtype + " id=" + D.id + " isSkipMode=" + D.skip);
        return r;
      };
      CR.prototype.loadMission.__zqd = 1;
      log("diag: ConfigReader.loadMission hooked");
    }
  }

  function tick() {
    try {
      var f = fs();
      if (f && !S.writable) { try { S.writable = f.getWritablePath() || ""; } catch (e) {} }
      readFlags();
      hookBattle();
      hookAd();
      hookReport();
      hookDiag();
      applySpeed();
      if (S.hp && S.unit) {
        if (S.inst !== 2) { S.inst = 2; log("hooks installed hp/unit" + (S.mad ? " +ad" : "")); }
      }
      if (S.inst === 2 && !S.seen) {
        S.seen = "HpUnit" + (S.mad ? "/MAD" : "") + (S.bu ? "/BU" : "") +
                 (S.sch ? "/SCH" : "") + "/aux" + S.aux;
      }
      writeProbe();
    } catch (e) { S.note = "tick-err:" + e; }
  }

  log("runtime armed");
  try { tick(); } catch (e) {}
  if (typeof setInterval === "function") { setInterval(tick, 500); }
  else { var _tz = setTimeout; (function loop() { tick(); _tz(loop, 500); })(); }
})();
