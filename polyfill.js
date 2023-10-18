require('websocket-polyfill');

if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
  global.crypto = {
    getRandomValues: function (buffer) {
      return require('crypto').randomFillSync(buffer);
    }
  };
}