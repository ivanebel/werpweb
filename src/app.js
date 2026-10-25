'use strict';

const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const methodOverride = require('method-override');

const config = require('./config');
const { getPool } = require('./db');
const { locale, sessionFlash, csrf, webLocals, localizeResponses, requireAuth, requireRole } = require('./middleware/web');

const authRoutes = require('./routes/auth');
const languageRoutes = require('./routes/language');
const dashboardRoutes = require('./routes/dashboard');
const searchRoutes = require('./routes/search');
const customerRoutes = require('./routes/customers');
const supplierRoutes = require('./routes/suppliers');
const employeeRoutes = require('./routes/employees');
const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const brandRoutes = require('./routes/brands');
const salesOrderRoutes = require('./routes/salesOrders');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
const salesInvoiceRoutes = require('./routes/salesInvoices');
const purchaseInvoiceRoutes = require('./routes/purchaseInvoices');
const paymentRoutes = require('./routes/payments');
const checkRoutes = require('./routes/checks');
const deliveryRoutes = require('./routes/deliveries');
const carrierRoutes = require('./routes/carriers');
const bankAccountRoutes = require('./routes/bankAccounts');
const manufacturingRoutes = require('./routes/manufacturing');
const posRoutes = require('./routes/pos');
const emailRoutes = require('./routes/emails');
const settingsRoutes = require('./routes/settings');

async function createApp() {
  const app = express();
  const root = config.root;

  const viewsDir = path.join(root, 'src', 'views');
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Absolute includes such as include('/layouts/head') resolve against the views root.
  app.engine('ejs', (filePath, options, callback) => {
    ejs.renderFile(filePath, options, { root: viewsDir }, callback);
  });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(
    express.static(path.join(root, 'public'), {
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
    }),
  );
  app.use(
    '/vendor/apexcharts',
    express.static(path.join(root, 'node_modules', 'apexcharts', 'dist'), { maxAge: '7d' }),
  );

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(methodOverride('_method'));

  const store = new MySQLStore(
    {
      createDatabaseTable: true,
      clearExpired: true,
      checkExpirationInterval: 15 * 60 * 1000,
      expiration: 8 * 60 * 60 * 1000,
      endConnectionOnClose: false,
      schema: {
        tableName: 'sessions',
        columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
      },
    },
    getPool(),
  );
  await store.onReady();

  app.use(
    session({
      name: 'werp.sid',
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction ? 'auto' : false,
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(locale);
  app.use(sessionFlash);
  app.use(csrf);
  app.use(webLocals);
  app.use(localizeResponses);

  app.use(languageRoutes);
  app.use(authRoutes);
  app.use(requireAuth);

  app.use('/', dashboardRoutes);
  app.use('/search', searchRoutes);
  app.use('/customers', customerRoutes);
  app.use('/suppliers', supplierRoutes);
  app.use('/employees', employeeRoutes);
  app.use('/products', productRoutes);
  app.use('/product-categories', categoryRoutes);
  app.use('/brands', brandRoutes);
  app.use('/sales-orders', salesOrderRoutes);
  app.use('/purchase-orders', purchaseOrderRoutes);
  app.use('/sales', salesInvoiceRoutes);
  app.use('/purchases', purchaseInvoiceRoutes);
  app.use('/payments', paymentRoutes);
  app.use('/checks', checkRoutes);
  app.use('/deliveries', deliveryRoutes);
  app.use('/carriers', requireRole('admin', 'manager'), carrierRoutes);
  app.use('/bank-accounts', requireRole('admin', 'manager'), bankAccountRoutes);
  app.use('/manufacturing', manufacturingRoutes);
  app.use('/pos', posRoutes);
  app.use('/emails', emailRoutes);
  app.use('/', settingsRoutes);

  app.use((req, res) => {
    res.status(404).render('errors/404', {
      title: req.t('Page not found'),
      active: '',
      breadcrumbs: [],
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err.stack || err);
    if (res.headersSent) return;
    const errorLocale = req.locale || res.locals.locale || 'en';
    res.status(status).render('errors/error', {
      title: status === 403 ? req.t('Access denied') : req.t('Something went wrong'),
      active: '',
      breadcrumbs: [],
      status,
      message:
        status >= 500 && config.isProduction
          ? req.t('An unexpected error occurred. Please try again or contact your administrator.')
          : err.message,
      // Errors can happen before webLocals runs (for example, a CSRF failure).
      // Supply the layout locals the error page needs so it still renders.
      htmlLang: errorLocale,
      locale: errorLocale,
      csrfToken: res.locals.csrfToken || '',
      jsMessages: res.locals.jsMessages || {},
      settings: res.locals.settings || { company_name: 'WerpWeb' },
    });
  });

  return app;
}

module.exports = { createApp };
