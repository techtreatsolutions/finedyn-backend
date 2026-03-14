'use strict';

function generateTablePin() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

module.exports = { generateTablePin };
