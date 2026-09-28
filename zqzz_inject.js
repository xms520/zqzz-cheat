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
    writable: "", hp: 0, unit: 0, mad: 0, sock: 0, bu: 0, aux: 0, sch: 0, rplHook: 0, omHook: 0, ib2: 0, ib3: 0, atkMul: 1, kh2: 0, killHits2: 0, lastDmg: "", passReq: 0, passCnt: 0, passPrev: 0,
    killHits: 0, invBlocks: 0, seen: "", note: "boot", log: ""
  };

  /* 诊断：记录战斗驱动来源，用于区分"本地模拟"与"服务端战报回放"
     - sim : BattleLogic.frameUpdate 被调用的次数（本地模拟在跑）
     - rpl : pveBattleMgr.frameUpdate 被调用的次数（服务端战报回放在跑）
     - mtype: 最近一次 ConfigReader.loadMission 的 missionType
     - skip : 最近一次 loadMission 的 isSkipMode
  */
  var D = window.__ZQZZ_D__ = { sim: 0, rpl: 0, mtype: -1, skip: 0, simFrames: 0, rplFrames: 0, proto: [] };
  var g_passMissionId = -1;   // 一键通关用的当前关卡 id（由 loadMission 抓取）
  S.diag = "";

  function fs() { try { return jsb.fileUtils; } catch (e) { return null; } }

  function log(s) {
    S.log = (S.log + "[" + Date.now() + "] " + s + "\n").slice(-3000);
    var f = fs(); if (!f) return;
    try { f.writeStringToFile(S.log, LOGF); } catch (e) {}
  }

  function writeProbe() {
    var f = fs(); if (!f) return;
    var t = "ver=v9 inst=" + S.inst + " kill=" + S.kill + " inv=" + S.inv + " noad=" + S.noad +
            " spd=" + S.spd + " cur=" + S.cur +
            " hp=" + S.hp + " unit=" + S.unit + " mad=" + S.mad + " sock=" + S.sock +
            " bu=" + S.bu + " aux=" + S.aux + " sch=" + S.sch + " rplHook=" + S.rplHook +
            " om=" + S.omHook + " ib2=" + S.ib2 + " ib3=" + S.ib3 +
            " atkMul=" + S.atkMul + " kh2=" + S.kh2 + " kh3=" + S.killHits2 + " pc=" + S.passCnt +
            " kh=" + S.killHits + " ib=" + S.invBlocks +
            " sim=" + D.sim + " rpl=" + D.rpl + " mtype=" + D.mtype + " skip=" + D.skip +
            " proto=" + D.proto.length + " seen=" + S.seen + " note=" + S.note;
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
      /* atkMul = 攻击倍率（1=关；2/5/10/100 等），未知值安全回退 1 */
      var am = Number(j.atkMul);
      S.atkMul = (am > 1 && am <= 1000) ? am : 1;
      /* pass: 一键通关触发（边沿检测：仅 0→1 时执行一次，避免 flags 常驻导致重复发） */
      var pv = j.pass ? 1 : 0;
      if (pv === 1 && S.passPrev === 0) S.passReq = 1;
      S.passPrev = pv;
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

  /* ---------- 战报回放路径（副本/PVP）：拦截服务端下发的血量 ----------
     ⚠️ 实测：副本走的是【pvpBattleMgr】而非 pveBattleMgr！证据：
       - pvpBattleMgr 处理 S2C_Player_FieldBoss_Fight / S2C_FightMine_XGDJ /
         S2C_KFArena_Fight / S2C_KFTianTi_Fight / S2C_GuildClash 等
       - msgReceiveLevelFight → 收集 warResults → fightFrameInfo
       - frameUpdate 按 warReport.frameList 逐帧推进
       - **initUnitHp(startFrame, warResult) 中 `v.setting.initHp = s[v.id]`** ← 血量真正落点
     （pveBattleMgr 虽也有 resetUnitGroupHp，但副本不走它，真机 rpl=0 已证实）
     单位归属：warResults[0].atk = 我方，def = 敌方。 */
  function hookReport() {
    var keys = ["pveBattleMgr", "pvpBattleMgr", "gameBattleMgr", "skillBattleMgr", "pveVioFightMgr"];
    var n = 0;

    /* 把某侧 units 血量顶回满血（用于无敌） */
    function refill(units) {
      for (var k in units) {
        var u = units[k];
        if (u && u.setting) {
          var mx = u.setting.maxHp || u.setting.initHp || 0;
          if (mx > 0) {
            u.setting.initHp = mx;
            if (u.hpEngine) u.hpEngine.hp = mx;
          }
        }
      }
    }

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
            if (S.inv && this.groupUnit && this.groupUnit.atk && this.groupUnit.atk.units)
              refill(this.groupUnit.atk.units);
          } catch (e2) {}
          return r;
        };
        C.prototype.setGroupUnit.__zq = 1;
        n++;
      } else if (C.prototype.setGroupUnit) { n++; }

      /* ★ 副本/PVP 真正的血量落点：initUnitHp(startFrame, warResult) */
      if (C.prototype.initUnitHp && C.prototype.initUnitHp.__zq !== 1) {
        var oInit = C.prototype.initUnitHp;
        C.prototype.initUnitHp = function (t) {
          D.rpl++;
          var r = oInit.call(this, t);
          try {
            var o = t && t.warResult;
            if (S.inv && o && o.atk && o.atk.units) refill(o.atk.units);
          } catch (e3) {}
          return r;
        };
        C.prototype.initUnitHp.__zq = 1;
        log("report hook " + keys[i] + ".initUnitHp ★副本血量落点");
        n++;
      } else if (C.prototype.initUnitHp) { n++; }

      /* 战报接收：一收到就把我方血量顶满 */
      if (C.prototype.msgReceiveLevelFight && C.prototype.msgReceiveLevelFight.__zq !== 1) {
        var oRecv = C.prototype.msgReceiveLevelFight;
        C.prototype.msgReceiveLevelFight = function (t) {
          var r = oRecv.call(this, t);
          try {
            var o = t && t.warResult, ws = o && o.warResults;
            if (S.inv && ws) for (var k = 0; k < ws.length; k++) {
              var w = ws[k];
              if (w && w.atk && w.atk.units) refill(w.atk.units);
            }
          } catch (e4) {}
          return r;
        };
        C.prototype.msgReceiveLevelFight.__zq = 1;
        log("report hook " + keys[i] + ".msgReceiveLevelFight");
        n++;
      } else if (C.prototype.msgReceiveLevelFight) { n++; }
    }
    if (n > S.rplHook) S.rplHook = n;
  }

  /* ---------- 通用单位层（覆盖全部战斗类型） ----------
     ordMonster 是战斗单位的显示脚本，所有战斗类型最终都经由它更新血量：
       setMonsterHp(hp, atkId, force)  ← 血量写入 + 死亡判定
       setUnitDead()                   ← 死亡落点
       isMyselfAtk                     ← 阵营（true = 我方）
     这是最底层、最通用的点位，不依赖具体是哪个 BattleMgr。 */
  function hookUnitDisplay() {
    var om = req("ordMonster");
    var OM = ctor(om, "ordMonster");
    if (!OM || !OM.prototype) return;
    var n = 0;

    if (OM.prototype.setMonsterHp && OM.prototype.setMonsterHp.__zq !== 1) {
      var oSetHp = OM.prototype.setMonsterHp;
      OM.prototype.setMonsterHp = function (hp, atkId, force) {
        try {
          /* ---- 无敌：我方血量拒绝下降 ---- */
          if (S.inv && this.isMyselfAtk) {
            S.ib2 = (S.ib2 || 0) + 1;
            this.isMonsterDead = false;
            if (this.monsterData && this.monsterData.setting) {
              var mx = this.monsterData.setting.maxHp || this.maxHp || 1;
              this.monsterData.setting.initHp = mx;
            }
            this.monsterHp = this.maxHp || 1;
            if (cc && cc.isValid && cc.isValid(this.bloodNode)) {
              try { this.updateBloodInfo(this.monsterHp, this.monstermp); } catch (x2) {}
            }
            return;
          }
          /* ---- 倍攻：按【已损失血量比例】放大（基准用 maxHp，固定不漂移） ----
             ⚠️ 坑1：hp 是绝对值（服务端下发），不是伤害量，不能直接乘。
             ⚠️ 坑2：若拿"上一帧血量"当基准，会随血量一起下滑而发散
                     （例：100 放大成 50 后，服务端发 90 反而 >= 50，差分永久失效）。
                     ⇒ 必须用固定的 this.maxHp 当基准。
             ⚠️ 坑3：调用方 gameBattleMgr:719 是 `n.setMonsterHp(t.hp)` 只传 1 参，
                     原函数死亡判定 `t <= 0 && e` 中 e 为 undefined ⇒ 永不死亡。下面补传 atkId。

             算法：srvLost = 服务端已损失比例 → bigLost = srvLost * atkMul
                   bigLost >= 1 即直接击杀（hp = 0，触发 setUnitDead） */
          var raw = hp;
          if (S.atkMul > 1 && !this.isMyselfAtk && typeof raw === "number") {
            var max = this.maxHp || (this.monsterData && this.monsterData.setting && this.monsterData.setting.maxHp) || 0;
            if (max > 0 && raw < max && raw >= 0) {
              var srvLost = (max - raw) / max;
              var bigLost = srvLost * S.atkMul;
              var nh2 = bigLost >= 1 ? 0 : max * (1 - bigLost);
              S.kh2 = (S.kh2 || 0) + 1;
              S.lastDmg = max + "/" + raw + " lost" + (srvLost * 100).toFixed(1) + "%x" + S.atkMul;
              hp = nh2;
              if (hp <= 0) S.killHits2 = (S.killHits2 || 0) + 1;
            }
          }
        } catch (x) {}
        /* 关键：补传 atkId（非 0 真值）让原函数的死亡判定 `t <= 0 && e` 成立 */
        if (typeof atkId === "undefined" || !atkId) atkId = -1;
        return oSetHp.call(this, hp, atkId, force);
      };
      OM.prototype.setMonsterHp.__zq = 1;
      log("unit hook ordMonster.setMonsterHp ★通用血量入口");
      n++;
    }

    if (OM.prototype.setUnitDead && OM.prototype.setUnitDead.__zq !== 1) {
      var oDead = OM.prototype.setUnitDead;
      OM.prototype.setUnitDead = function () {
        try { if (S.inv && this.isMyselfAtk) { S.ib3 = (S.ib3 || 0) + 1; return; } } catch (x) {}
        return oDead.call(this);
      };
      OM.prototype.setUnitDead.__zq = 1;
      log("unit hook ordMonster.setUnitDead");
      n++;
    }

    if (n > (S.omHook || 0)) S.omHook = n;
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
          if (D.id > 0) g_passMissionId = D.id;
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

  /* ---------- 全协议探针：记录进入的 S2C 协议号，用于定位副本走哪条链 ----------
     EMgr.receiveEL(protoId, ...) 是所有网络消息的唯一分发点（实证）。 */
  var PROTO = "@@PROTO_PATH@@";
  function hookProto() {
    var em = req("EMgr");
    var EM = ctor(em, "EMgr");
    if (!EM || !EM.prototype || !EM.prototype.receiveEL) return;
    if (EM.prototype.receiveEL.__zqp === 1) return;
    var oR = EM.prototype.receiveEL;
    EM.prototype.receiveEL = function (id) {
      try {
        if (id && D.proto.indexOf(id) < 0) {
          D.proto.push(id);
          if (D.proto.length > 64) D.proto.shift();
          var f = fs();
          if (f) f.writeStringToFile("ver=v9 protocols: " + D.proto.join(","), PROTO);
        }
      } catch (e) {}
      return oR.apply(this, arguments);
    };
    EM.prototype.receiveEL.__zqp = 1;
    log("diag: EMgr.receiveEL hooked (全协议探针)");
  }

  /* ---------- 一键通关 ----------
     原理（逆向实证）：pveBattleMgr.sendMissionFightEnd(isSuc, type) 中
       result: isSuc ? suc : fail → sendNetMsg(C2S_PlayerFb_Fight = 2401, o)
       o = { missionId, result, resultType, tankIds, wave, killPos, speed }
     ⇒ 胜负由【客户端上报】。pveBattleMgr 是场景组件（无静态单例），
        故优先用实例方法，拿不到就直接自己组包发 2401。

     ⚠️⚠️ 高风险：服务端可能校验战斗时长/击杀/波次（wave / killPos 本应来自真实战报）。
        未实际战斗直接上报可能被判异常（无效 / 风控）。默认关闭，仅用户显式点击时执行一次。 */
  function forcePass() {
    var m = req("pveBattleMgr");
    var C = ctor(m, "pveBattleMgr");
    var inst = C && (C.I || (typeof C.getInstance === "function" ? C.getInstance() : null));
    if (inst && typeof inst.sendMissionFightEnd === "function") {
      try {
        inst.sendMissionFightEnd(true, 0);
        S.note = "pass:inst(mid=" + inst.missionId + ")";
        log("forcePass via instance mid=" + inst.missionId);
        return true;
      } catch (e) {}
    }
    var smI = singleton(req("SocketMgr"), "SocketMgr");
    var nc = table(req("mainNetCode"), "mainNetCode");
    if (!(smI && nc && nc.C2S_PlayerFb_Fight)) { S.note = "pass:no-socket"; return false; }
    try {
      var tanks = "";
      try {
        var MT = (req("ModelTroops") || {}).default;
        if (MT && MT.I && typeof MT.I.getPveTroop === "function") {
          var tr = MT.I.getPveTroop(1);
          if (tr && tr.troop) for (var k in tr.troop) tanks += tr.troop[k] + ",";
        }
      } catch (e2) {}
      var o = {
        missionId: (g_passMissionId > 0 ? g_passMissionId : 0),
        result: 1, resultType: 0, tankIds: tanks,
        wave: 1, killPos: "", speed: 0
      };
      smI.sendNetMsg(nc.C2S_PlayerFb_Fight, o);
      S.note = "pass:sent mid=" + o.missionId;
      log("forcePass -> C2S_PlayerFb_Fight(2401) " + JSON.stringify(o));
      return true;
    } catch (e3) { S.note = "pass-err:" + e3; }
    return false;
  }

  function tick() {
    try {
      var f = fs();
      if (f && !S.writable) { try { S.writable = f.getWritablePath() || ""; } catch (e) {} }
      readFlags();
      hookBattle();
      hookAd();
      hookReport();
      hookUnitDisplay();
      hookDiag();
      hookProto();
      applySpeed();
      if (S.passReq) { S.passReq = 0; S.passCnt++; forcePass(); }
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
