const { sendError } = require('../lib/dispatch/http');

function createDispatchUnknownHandler() {
  return async function dispatchUnknown(_req, res) {
    return sendError(res, 404, 'not_found');
  };
}

module.exports = createDispatchUnknownHandler();
module.exports.createDispatchUnknownHandler = createDispatchUnknownHandler;
