'use strict';

const { makeDocumentRouter } = require('./documents');
const { purchase_order } = require('../lib/documentTypes');

module.exports = makeDocumentRouter(purchase_order);
