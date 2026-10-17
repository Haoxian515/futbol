'use strict';
// UEFA Europa League chart — see lib/uefa_club.js.
module.exports = require('./uefa_club').make({
  comp: 14, key: 'uel', name: 'UEFA Europa League', short: 'Europa League', abbr: 'UEL',
  odds: 'soccer_uefa_europa_league', sg: 'uefa-europa-league', tuned: false,
});
