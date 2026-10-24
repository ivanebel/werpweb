'use strict';

const { makeDocumentRouter } = require('./documents');
const { purchase_invoice } = require('../lib/documentTypes');

module.exports = makeDocumentRouter(purchase_invoice);
