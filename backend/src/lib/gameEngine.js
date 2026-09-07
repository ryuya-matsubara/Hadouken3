/*
 * Hadouken Battle - shared game rule engine
 * =========================================
 * This module is the SINGLE SOURCE OF TRUTH for the battle rules. It is loaded
 * both in the browser (for the offline hot-seat mode and for local prediction)
 * and inside AWS Lambda (as the AUTHORITATIVE resolver for online matches).
 *
 * It is intentionally free of any DOM, network, AWS or randomness dependency so
 * that it is fully deterministic and unit-testable. Given the same inputs it
 * always produces the same outputs.
 *
 * The logic here mirrors the original single-file game (resolveTurn /
 * applyCosts / applyEvents) so that offline and online battles resolve
 * identically. When the rules change, change them here only.
 *
 * UMD-ish export: works with CommonJS (Node/Lambda) and as a browser global
 * (window.HadoukenEngine).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api; // Node / Lambda / tests
  } else {
    root.HadoukenEngine = api; // browser
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_ENERGY = 3;
  var MAX_HP = 3;

  // ---- Character roster (rules only; artwork lives in the frontend) --------
  // kind: "attack" | "heal" | "drain"
  var CHARACTERS = {
    hadou: {
      id: "hadou",
      name: "Hadou",
      special: { name: "波動拳", cost: 3, dmg: 1, guardable: false, kind: "attack" },
    },
    blaze: {
      id: "blaze",
      name: "Blaze",
      special: { name: "メガブラスト", cost: 2, dmg: 2, guardable: true, kind: "attack" },
    },
    phantom: {
      id: "phantom",
      name: "Phantom",
      special: { name: "VOID", cost: 0, dmg: 0, guardable: false, kind: "drain" },
    },
    angel: {
      id: "angel",
      name: "Angel",
      special: { name: "ヒール", cost: 2, dmg: 0, guardable: false, kind: "heal" },
    },
  };

  var CHAR_ORDER = ["hadou", "blaze", "phantom", "angel"];
  var ACTIONS = ["charge", "blast", "guard", "special"];

  // ---- Validation helpers ---------------------------------------------------
  function isValidCharId(id) {
    return Object.prototype.hasOwnProperty.call(CHARACTERS, id);
  }
  function isValidAction(a) {
    return ACTIONS.indexOf(a) !== -1;
  }

  // Energy cost of an action for a given character.
  function actionCost(charId, action) {
    if (action === "charge") return 0;
    if (action === "blast") return 1;
    if (action === "guard") return 0;
    if (action === "special") return CHARACTERS[charId].special.cost;
    return 0;
  }

  // Can a player afford this action given their current energy?
  function canAfford(charId, action, energy) {
    return energy >= actionCost(charId, action);
  }

  // Validate that an action is legal for a player in the current state.
  // Returns { ok: true } or { ok: false, reason: "..." }.
  function validateAction(charId, action, energy) {
    if (!isValidCharId(charId)) return { ok: false, reason: "invalid_character" };
    if (!isValidAction(action)) return { ok: false, reason: "invalid_action" };
    if (!canAfford(charId, action, energy)) return { ok: false, reason: "not_enough_energy" };
    return { ok: true };
  }

  // ---- Turn resolution ------------------------------------------------------
  // Pure function. Given the character ids, the two chosen actions and the
  // "before" HP/energy, returns the full outcome AND the resulting state.
  //
  // input:
  //   chars  = { 1: "hadou", 2: "blaze" }
  //   a1, a2 = action strings for player 1 / player 2
  //   hp     = { 1: n, 2: n }
  //   energy = { 1: n, 2: n }
  //
  // returns:
  //   {
  //     valid: bool,               // false if either action was illegal
  //     invalid: { 1:reason|null, 2:reason|null },
  //     events: [ {type, target, amount, ...} ],
  //     logs: [ "相殺！", ... ],
  //     clash: bool,
  //     fails: { 1:bool, 2:bool },
  //     isAttack: { 1:bool, 2:bool },
  //     before: { hp, energy },
  //     after:  { hp, energy },
  //     finished: bool,
  //     winner: 0|1|2|null,        // 0 = draw, null = not finished
  //   }
  function resolveTurn(chars, a1, a2, hp, energy) {
    var c1 = CHARACTERS[chars[1]];
    var c2 = CHARACTERS[chars[2]];

    // Validate both actions against the *authoritative* energy values.
    var v1 = validateAction(chars[1], a1, energy[1]);
    var v2 = validateAction(chars[2], a2, energy[2]);
    var invalid = { 1: v1.ok ? null : v1.reason, 2: v2.ok ? null : v2.reason };
    if (!v1.ok || !v2.ok) {
      return {
        valid: false,
        invalid: invalid,
        events: [],
        logs: [],
        clash: false,
        fails: { 1: false, 2: false },
        isAttack: { 1: false, 2: false },
        before: { hp: cloneObj(hp), energy: cloneObj(energy) },
        after: { hp: cloneObj(hp), energy: cloneObj(energy) },
        finished: false,
        winner: null,
      };
    }

    var sp1 = c1.special, sp2 = c2.special;
    var events = [];
    var logs = [];

    function special(p) { return (p === 1 ? c1 : c2).special; }

    var isAttack = function (p, a) {
      return a === "blast" || (a === "special" && special(p).kind === "attack");
    };

    // "Blast-type" projectiles clash (plain blast or a guardable attack special
    // = メガブラスト). 波動拳 is unguardable/piercing and does NOT clash.
    var isBlastType = function (p, a) {
      return a === "blast" ||
        (a === "special" && special(p).kind === "attack" && special(p).guardable);
    };
    var clash = isBlastType(1, a1) && isBlastType(2, a2);

    // 波動拳 = unguardable/piercing attack special. Overpowers a blast-type.
    var isPierce = function (p, a) {
      return a === "special" && special(p).kind === "attack" && !special(p).guardable;
    };
    var p1Pierce = isPierce(1, a1), p2Pierce = isPierce(2, a2);

    function attackResult(attacker, action, defAction) {
      if (action === "blast") {
        if (defAction === "guard") return { dmg: 0, blocked: true };
        return { dmg: 1, blocked: false };
      }
      if (action === "special") {
        var sp = special(attacker);
        if (sp.kind === "attack") {
          if (sp.guardable && defAction === "guard") return { dmg: 0, blocked: true };
          return { dmg: sp.dmg, blocked: false };
        }
      }
      return { dmg: 0, blocked: false, whiff: true };
    }

    // Heal (Angel)
    [1, 2].forEach(function (p) {
      var a = p === 1 ? a1 : a2;
      if (a === "special" && special(p).kind === "heal") {
        events.push({ type: "heal", target: p, amount: 1 });
      }
    });

    // VOID drain: reduces opponent energy by 1.
    [1, 2].forEach(function (p) {
      var a = p === 1 ? a1 : a2;
      if (a === "special" && special(p).kind === "drain") {
        var opp = p === 1 ? 2 : 1;
        events.push({ type: "drain", target: opp, amount: 1 });
      }
    });

    var fails = { 1: false, 2: false };

    if (clash) {
      logs.push("相殺！");
    } else {
      var res1 = attackResult(1, a1, a2);
      var res2 = attackResult(2, a2, a1);

      var p1Fails = isBlastType(1, a1) && p2Pierce;
      var p2Fails = isBlastType(2, a2) && p1Pierce;
      fails = { 1: p1Fails, 2: p2Fails };

      if (a1 === "blast" || (a1 === "special" && sp1.kind === "attack")) {
        if (p1Fails) {
          logs.push("プレイヤー1の" + (a1 === "special" ? sp1.name : "ブラスト") + "は失敗！");
        } else if (res1.blocked) {
          logs.push("プレイヤー2のガード成功！");
        } else if (res1.dmg > 0) {
          events.push({ type: "dmg", target: 2, amount: res1.dmg, from: 1, action: a1 });
        }
      }
      if (a2 === "blast" || (a2 === "special" && sp2.kind === "attack")) {
        if (p2Fails) {
          logs.push("プレイヤー2の" + (a2 === "special" ? sp2.name : "ブラスト") + "は失敗！");
        } else if (res2.blocked) {
          logs.push("プレイヤー1のガード成功！");
        } else if (res2.dmg > 0) {
          events.push({ type: "dmg", target: 1, amount: res2.dmg, from: 2, action: a2 });
        }
      }
    }

    // ---- Apply state changes (authoritative) ----
    var before = { hp: cloneObj(hp), energy: cloneObj(energy) };
    var newHp = cloneObj(hp);
    var newEnergy = cloneObj(energy);

    // Costs first (matches original applyCosts: charge +1, else -cost).
    [1, 2].forEach(function (p) {
      var a = p === 1 ? a1 : a2;
      if (a === "charge") {
        newEnergy[p] = Math.min(MAX_ENERGY, newEnergy[p] + 1);
      } else {
        newEnergy[p] = Math.max(0, newEnergy[p] - actionCost(chars[p], a));
      }
    });

    // Then events (dmg / heal / drain).
    events.forEach(function (ev) {
      if (ev.type === "dmg") newHp[ev.target] = Math.max(0, newHp[ev.target] - ev.amount);
      if (ev.type === "heal") newHp[ev.target] = Math.min(MAX_HP, newHp[ev.target] + ev.amount);
      if (ev.type === "drain") newEnergy[ev.target] = Math.max(0, newEnergy[ev.target] - ev.amount);
    });

    var dead1 = newHp[1] <= 0, dead2 = newHp[2] <= 0;
    var finished = dead1 || dead2;
    var winner = null;
    if (finished) {
      if (dead1 && dead2) winner = 0;
      else winner = dead2 ? 1 : 2;
    }

    return {
      valid: true,
      invalid: invalid,
      events: events,
      logs: logs,
      clash: clash,
      fails: fails,
      isAttack: { 1: isAttack(1, a1), 2: isAttack(2, a2) },
      before: before,
      after: { hp: newHp, energy: newEnergy },
      finished: finished,
      winner: winner,
    };
  }

  function cloneObj(o) { return { 1: o[1], 2: o[2] }; }

  function initialStats() {
    return { hp: { 1: MAX_HP, 2: MAX_HP }, energy: { 1: 0, 2: 0 } };
  }

  return {
    MAX_ENERGY: MAX_ENERGY,
    MAX_HP: MAX_HP,
    CHARACTERS: CHARACTERS,
    CHAR_ORDER: CHAR_ORDER,
    ACTIONS: ACTIONS,
    isValidCharId: isValidCharId,
    isValidAction: isValidAction,
    actionCost: actionCost,
    canAfford: canAfford,
    validateAction: validateAction,
    resolveTurn: resolveTurn,
    initialStats: initialStats,
  };
});
