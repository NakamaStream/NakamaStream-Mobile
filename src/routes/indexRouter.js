const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('index');
});

router.get('/error', (req, res) => {
  res.render('error/error');
})

router.get('/soon', (req, res) => {
  res.render('error/soon');
})

router.get('/news', (req, res) => {
  res.render('error/soon');
})

router.get('/tos', (req, res) => {
  res.redirect("https://nakamastream.lat/tos");
})

router.get('/privacy', (req, res) => {
  res.redirect("https://nakamastream.lat/privacy");
})

router.get('/about/jobs', (req, res) => {
  res.render('res.redirect("https://nakamastream.lat/about/jobs");');
})

router.get('/donate', (req, res) => {
  res.redirect("https://nakamastream.lat/donate");
});

router.get('/desktop', (req, res) => {
  res.redirect("https://nakamastream.lat/desktop");
});

router.get('/mobile', (req, res) => {
  res.redirect("https://nakamastream.lat/mobile");
});

router.get('/jobs/frontend', (req, res) => {
  res.redirect('https://github.com/orgs/NakamaStream/discussions/10');
});

router.get('/jobs/backend', (req, res) => {
  res.redirect('https://github.com/orgs/NakamaStream/discussions/11');
});

router.get('/jobs/moderador', (req, res) => {
  res.redirect('https://github.com/orgs/NakamaStream/discussions/12');
});

router.get('/jobs/administrador', (req, res) => {
  res.redirect('https://github.com/orgs/NakamaStream/discussions/13');
});

module.exports = router;
