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
    writable: "", hp: 0, unit: 0, mad: 0, sock: 0, bu: 0, aux: 0, sch: 0, rplHook: 0, omHook: 0, ib2: 0, ib3: 0, atkMul: 1, kh2: 0, killHits2: 0, lastDmg: "", hpCalls: 0, onlyMain: 1, battleType: -1, cfgTables: 0, cfgDump: "", cfgSet: null, cfgFind: "", cfgFindTables: "", cfgKey: "", dumpSig: "", hpMine: 0, hpFoe: 0,
    killHits: 0, invBlocks: 0, seen: "", note: "boot", log: ""
  };

  /* 诊断：记录战斗驱动来源，用于区分"本地模拟"与"服务端战报回放"
     - sim : BattleLogic.frameUpdate 被调用的次数（本地模拟在跑）
     - rpl : pveBattleMgr.frameUpdate 被调用的次数（服务端战报回放在跑）
     - mtype: 最近一次 ConfigReader.loadMission 的 missionType
     - skip : 最近一次 loadMission 的 isSkipMode
  */
  var D = window.__ZQZZ_D__ = { sim: 0, rpl: 0, mtype: -1, skip: 0, simFrames: 0, rplFrames: 0, proto: [] };
  S.diag = "";

  function fs() { try { return jsb.fileUtils; } catch (e) { return null; } }

  function log(s) {
    S.log = (S.log + "[" + Date.now() + "] " + s + "\n").slice(-3000);
    var f = fs(); if (!f) return;
    try { f.writeStringToFile(S.log, LOGF); } catch (e) {}
  }

  function writeProbe() {
    var f = fs(); if (!f) return;
    var t = "ver=v16 inst=" + S.inst + " kill=" + S.kill + " inv=" + S.inv + " noad=" + S.noad +
            " spd=" + S.spd + " cur=" + S.cur +
            " hp=" + S.hp + " unit=" + S.unit + " mad=" + S.mad + " sock=" + S.sock +
            " bu=" + S.bu + " aux=" + S.aux + " sch=" + S.sch + " rplHook=" + S.rplHook +
            " om=" + S.omHook + " ib2=" + S.ib2 + " ib3=" + S.ib3 +
            " atkMul=" + S.atkMul + " kh2=" + S.kh2 + " kh3=" + S.killHits2 + 
            " hpCall=" + S.hpCalls + " hpM=" + S.hpMine + " hpF=" + S.hpFoe + " btype=" + S.battleType + " cfgT=" + S.cfgTables + " cfgK=" + S.cfgKey +
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
      /* onlyMain: 1=秒杀/倍攻仅对主线(LevelType.Common=1)生效，0=全部战斗 */
      if (typeof j.onlyMain !== "undefined") S.onlyMain = j.onlyMain ? 1 : 0;
      /* 配置表：cfgDump=1 打表名清单；cfgDump="表A,表B" 打指定表内容；cfgSet={...} 改值 */
      if (typeof j.cfgDump !== "undefined") S.cfgDump = j.cfgDump;
      if (j.cfgSet && typeof j.cfgSet === "object") S.cfgSet = j.cfgSet;
      if (typeof j.cfgFind !== "undefined") S.cfgFind = j.cfgFind;
      if (typeof j.cfgFindTables !== "undefined") S.cfgFindTables = j.cfgFindTables;
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
        S.hpCalls = (S.hpCalls || 0) + 1;      // 无条件计数：确认挂点是否真被调用
        var raw = hp;
        try {
          var mine = !!this.isMyselfAtk;
          if (mine) S.hpMine = (S.hpMine || 0) + 1; else S.hpFoe = (S.hpFoe || 0) + 1;

          /* ---- 无敌：我方血量拒绝下降 ---- */
          if (S.inv && mine) {
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

          /* ---- 秒杀/倍攻（敌方）----
             ⚠️ 服务端每帧回写血量，比例放大会被覆盖 ⇒ 必须一次性打到 0，
                并主动调用 setUnitDead 让 isMonsterDead=true 永久锁定
                （后续服务端再推血量会被原函数 `if (!this.isMonsterDead)` 早退忽略）。

             ⚠️⚠️ 副本不适用（实证）：副本/跨服战斗由服务端战报决定胜负，
                客户端改血只会造成"看着消失了、实际还存在"的显示/逻辑错位
                （ordMonster 是显示层、Unit 是逻辑层，服务端按自己的战报重建）。
                ⇒ 仅对 LevelType.Common(1) 主线启用；其他战斗类型一律不干预。
                如需放开全部，把 S.onlyMain 置 0（flags 里加 onlyMain:0）。 */
          if (!mine && typeof raw === "number" && (!S.onlyMain || this.battleType === 1)) {
            var maxHp = this.maxHp ||
              (this.monsterData && this.monsterData.setting && this.monsterData.setting.maxHp) || 0;
            var lost = maxHp > 0 && raw < maxHp;   // 已发生掉血（构造初始化时 raw==maxHp，不触发）
            if (lost) {
              if (S.kill) {
                /* 秒杀：任何掉血 → 直接归零 */
                S.kh2 = (S.kh2 || 0) + 1;
                hp = 0;
              } else if (S.atkMul > 1) {
                /* 倍攻：按已损失比例放大 */
                var srvLost = (maxHp - raw) / maxHp;
                var bigLost = srvLost * S.atkMul;
                S.kh2 = (S.kh2 || 0) + 1;
                S.lastDmg = maxHp + "/" + raw + " lost" + (srvLost * 100).toFixed(1) + "%x" + S.atkMul;
                hp = bigLost >= 1 ? 0 : maxHp * (1 - bigLost);
              }
            }
            /* 血量归零：主动致死（不依赖原函数的 atkId 判定） */
            if (hp <= 0) {
              S.killHits2 = (S.killHits2 || 0) + 1;
              this.monsterHp = 0;
              try {
                if (cc && cc.isValid && cc.isValid(this.bloodNode)) this.updateBloodInfo(0, this.monstermp);
              } catch (x3) {}
              /* ⚠️ setUnitDead 只隐藏显示节点（node.active=false），逻辑层单位仍"活着"，
                 会导致我方继续选中它攻击（表现为"跟空气对打"）。
                 必须同时把逻辑层的血量置 0 ⇒ Unit.isDeath() → HpEngine.isDeath() → hp<=0
                 ⇒ UnitGroup.isAllDead() 成立 ⇒ 战斗正常结束。 */
              try {
                var ud = this.monsterData;
                if (ud) {
                  if (ud.hpEngine) ud.hpEngine.hp = 0;
                  if (ud.setting) ud.setting.initHp = 0;
                }
              } catch (x5) {}
              this.isMonsterDead = true;
              try { this.setUnitDead(); } catch (x4) {}
              S.ib3 = (S.ib3 || 0) + 1;
              return;
            }
          }
        } catch (x) {}
        /* 补传 atkId（非 0 真值）让原函数的死亡判定 `t <= 0 && e` 成立 */
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
          if (f) f.writeStringToFile("ver=v16 protocols: " + D.proto.join(","), PROTO);
        }
      } catch (e) {}
      return oR.apply(this, arguments);
    };
    EM.prototype.receiveEL.__zqp = 1;
    log("diag: EMgr.receiveEL hooked (全协议探针)");
  }

  /* ---------- 配置表 dump / 改表 ----------
     实证链路：CDN 下载 spe.txt+cfg0~cfg3.txt → Pako.inflate → binary2string
               → CfgMgr.addJsonConfig(text) → this.configData[表名] = 表数据
     hook addJsonConfig 即可：① dump 全部表名与规模 ② 动态改表（绕过 md5 校验）

     flags 用法：
       "cfgDump": 1             → 把表名清单写到 zqzz_cfg.txt
       "cfgDump": "npc_tank,tank_base"  → 指定表的完整内容写到 zqzz_cfg_<表名>.json
       "cfgSet": {"表名#id#字段": 值}    → 运行时改值（如 {"ad_reward#1#max_count": 999}） */
  var CFG = "@@CFG_PATH@@";

  /* 关键表清单（客户端读取、体量适中、价值高） */
  var CFG_KEY = ["common_value", "tank_base", "ad_reward", "money_type",
                 "function_unlock", "drop_base", "item_base", "player_level",
                 "mission_type", "oil_cost", "setting", "ad_shop_box"];

  function cfgWrite(name, text) {
    var f = fs(); if (!f) return;
    try { f.writeStringToFile(text, name); } catch (e) {}
  }

  /* cfgDump: "auto" → 导出关键表到 zqzz_cfg_key.json（合并单文件，便于上传）
     cfgDump: "表A,表B" → 各表单独文件
     cfgFind: "关键词" → 在关键表里搜字段名，输出命中项 */
  function dumpKeyTables(cd) {
    var out = {};
    for (var i = 0; i < CFG_KEY.length; i++) {
      var nm = CFG_KEY[i];
      if (cd[nm]) out[nm] = cd[nm];
    }
    var p = CFG.replace(/zqzz_cfg\.txt$/, "zqzz_cfg_key.json");
    cfgWrite(p, JSON.stringify(out));
    log("cfgKey dumped: " + Object.keys(out).length + " tables");
    return Object.keys(out).join(",");
  }

  function findInTables(cd, kw) {
    var res = [];
    var keys = S.cfgFindTables ? S.cfgFindTables.split(",") : CFG_KEY;
    for (var ti = 0; ti < keys.length; ti++) {
      var tbl = cd[keys[ti].replace(/^\s+|\s+$/g, "")];
      if (!tbl) continue;
      for (var id in tbl) {
        var row = tbl[id];
        if (!row || typeof row !== "object") continue;
        for (var f in row) {
          if (f.toLowerCase().indexOf(kw.toLowerCase()) >= 0) {
            res.push(keys[ti] + "#" + id + "#" + f + " = " + JSON.stringify(row[f]));
          }
        }
      }
    }
    var p = CFG.replace(/zqzz_cfg\.txt$/, "zqzz_cfg_find.txt");
    cfgWrite(p, "keyword=" + kw + " hits=" + res.length + "\n" + res.slice(0, 500).join("\n"));
    log("cfgFind " + kw + " -> " + res.length + " hits");
    return res.length;
  }

  /* 从内存 configData 直接导出（不依赖 hook —— 配置表在登录时已加载完，
     用户点按钮时 addJsonConfig 早已执行过，hook 不会再触发） */
  function dumpFromMemory(inst) {
    var cd = inst && inst.configData;
    if (!cd) { S.note = "dump:no-configData"; return "no-data"; }
    var names = [];
    for (var k in cd) {
      var t = cd[k];
      var n = (t && typeof t === "object") ? (Array.isArray(t) ? t.length : Object.keys(t).length) : 1;
      names.push(k + "(" + n + ")");
    }
    S.cfgTables = names.length;
    cfgWrite(CFG, "ver=v16 cfgTables=" + names.length + "\n" + names.join("\n"));

    var want = S.cfgDump;
    var done = "tables:" + names.length;
    if (typeof want === "string" && want.length) {
      if (want === "auto" || want === "1" || want === "key") {
        S.cfgKey = dumpKeyTables(cd);
        done = "key=" + S.cfgKey;
      } else if (want === "all") {
        cfgWrite(CFG.replace(/zqzz_cfg\.txt$/, "zqzz_cfg_all.json"), JSON.stringify(cd));
        done = "all:" + names.length;
      } else {
        var arr = want.split(","), got = [];
        for (var i = 0; i < arr.length; i++) {
          var nm = arr[i].replace(/^\s+|\s+$/g, "");
          if (!nm || !cd[nm]) continue;
          cfgWrite(CFG.replace(/zqzz_cfg\.txt$/, "zqzz_cfg_" + nm + ".json"), JSON.stringify(cd[nm]));
          got.push(nm);
        }
        done = "tables=" + got.join(",");
      }
    }
    if (S.cfgFind) done += " find=" + findInTables(cd, S.cfgFind);
    S.note = "dump:" + done;
    log("cfg dump -> " + done);
    return done;
  }

  /* 检查按钮请求（边沿检测，避免 flags 常驻导致重复导出） */
  function checkDumpReq() {
    var CGm = req("CfgMgr");
    var inst = singleton(CGm, "CfgMgr");
    if (!inst) return;
    /* cfgDump=auto 常开时：只在首次或表数变化时导出一次 */
    var want = S.cfgDump;
    if (!want) return;
    var cd = inst.configData;
    if (!cd) return;
    var cnt = 0; for (var k in cd) cnt++;
    if (cnt === 0) { S.note = "dump:wait-cfg-loaded"; return; }
    var sig = want + "|" + cnt;
    if (S.dumpSig === sig) return;
    S.dumpSig = sig;
    dumpFromMemory(inst);
  }

  function hookCfg() {
    var m = req("CfgMgr");
    var CG = ctor(m, "CfgMgr");
    if (!CG || !CG.prototype) return;
    if (CG.prototype.addJsonConfig && CG.prototype.addJsonConfig.__zqc !== 1) {
      var oAdd = CG.prototype.addJsonConfig;
      CG.prototype.addJsonConfig = function (text) {
        var r = oAdd.call(this, text);
        try {
          /* 表名清单：每次加载都刷新（登录时会调用 5 次） */
          var cd = this.configData || {};
          var names = [];
          for (var k in cd) {
            var t = cd[k];
            var n = (t && typeof t === "object") ? (Array.isArray(t) ? t.length : Object.keys(t).length) : 1;
            names.push(k + "(" + n + ")");
          }
          S.cfgTables = names.length;
          cfgWrite(CFG, "ver=v16 cfgTables=" + names.length + "\n" + names.join("\n"));
        } catch (e) {}
        return r;
      };
      CG.prototype.addJsonConfig.__zqc = 1;
      log("diag: CfgMgr.addJsonConfig hooked (表名清单)");
    }
  }

  /* 运行时改表（在 addJsonConfig 之后、进入游戏后生效） */
  function applyCfgSet() {
    var set = S.cfgSet;
    if (!set || typeof set !== "object") return;
    var CGm = req("CfgMgr");
    var inst = singleton(CGm, "CfgMgr");
    if (!inst || !inst.configData) return;
    for (var path in set) {
      if (S.cfgApplied && S.cfgApplied[path] === 1) continue;
      var parts = path.split("#");
      try {
        if (parts.length === 3) {
          var tbl = inst.configData[parts[0]];
          if (tbl && tbl[parts[1]]) {
            tbl[parts[1]][parts[2]] = set[path];
            S.cfgApplied = S.cfgApplied || {};
            S.cfgApplied[path] = 1;
            S.note = "cfg:" + path + "=" + set[path];
            log("cfgSet " + path + " = " + set[path]);
          } else if (tbl) {
            tbl[parts[1]] = tbl[parts[1]] || {};
            tbl[parts[1]][parts[2]] = set[path];
            S.cfgApplied = S.cfgApplied || {};
            S.cfgApplied[path] = 1;
          }
        } else if (parts.length === 2) {
          var t2 = inst.configData[parts[0]];
          if (t2) {
            t2[parts[1]] = set[path];
            S.cfgApplied = S.cfgApplied || {};
            S.cfgApplied[path] = 1;
          }
        }
      } catch (e2) {}
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
      hookUnitDisplay();
      hookDiag();
      hookProto();
      hookCfg();
      checkDumpReq();
      applyCfgSet();
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
