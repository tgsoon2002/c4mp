const React = require('react');
// const old = require('./old-cart');
require('./cart.css');

const Cart = function () {
  return React.createElement('div', null, 'cart');
};

async function loadApp() {
  const { App } = await import('../App');
  return App;
}

module.exports = { Cart, loadApp };
