'use strict';
// UEFA Champions League chart — see lib/uefa_club.js.
module.exports = require('./uefa_club').make({
  comp: 1, key: 'ucl', name: 'UEFA Champions League', short: 'Champions League', abbr: 'UCL',
  odds: 'soccer_uefa_champs_league', sg: 'uefa-champions-league', tuned: true,
});
