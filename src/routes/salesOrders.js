'use strict';

const { makeDocumentRouter } = require('./documents');
const { sales_order } = require('../lib/documentTypes');

module.exports = makeDocumentRouter(sales_order);
