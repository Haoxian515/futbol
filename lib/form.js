'use strict';
// One game of a club's LAST 10, from its side: result, goals, penalty goals for / against
// (pf / pa null when the game has no penalty record), venue, opponent.

function formGame(x, team, extra = {}) {
  const home = x.home === team;
  const gf = home ? x.hg : x.ag;
  const ga = home ? x.ag : x.hg;
  const known = x.hp != null && x.ap != null;
  return {
    o: gf > ga ? 'W' : gf === ga ? 'D' : 'L', gf, ga, pf: known ? (home ? x.hp : x.ap) : null, pa: known ? (home ? x.ap : x.hp) : null,
    ha: x.neutral ? 'N' : home ? 'H' : 'A', opp: home ? x.away : x.home, date: x.date, ...extra,
  };
}

module.exports = { formGame };
