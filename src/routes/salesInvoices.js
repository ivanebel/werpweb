'use strict';

const { makeDocumentRouter } = require('./documents');
const { sales_invoice } = require('../lib/documentTypes');

module.exports = makeDocumentRouter(sales_invoice);
