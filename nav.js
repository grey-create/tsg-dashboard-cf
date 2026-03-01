// nav.js — Shared navigation bar for TSG dashboards
// Add <script src="/nav.js"></script> right after <body> in any page
(function(){
  // Work out previous month name for the review link
  var now = new Date();
  var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var prevMonthName = pm.toLocaleString('en-GB', { month: 'short' });

  var style = document.createElement('style');
  style.textContent = [
    '.top-nav{background:#000;display:flex;align-items:center;padding:0 32px;height:56px;gap:6px;border-bottom:1px solid #222;font-family:Inter,-apple-system,sans-serif;z-index:9999}',
    '.top-nav .tn-logo{width:30px;height:30px;filter:invert(1) brightness(2);margin-right:14px}',
    '.top-nav .tn-title{font-size:14px;font-weight:700;color:#fff;letter-spacing:-0.3px;margin-right:24px;white-space:nowrap}',
    '.top-nav .tn-pills{display:flex;gap:3px;background:#1a1a1a;border-radius:8px;padding:3px}',
    '.top-nav a{font-size:13px;font-weight:600;color:#888;text-decoration:none;padding:7px 18px;border-radius:6px;transition:all .15s;white-space:nowrap}',
    '.top-nav a:hover{color:#fff;background:rgba(255,255,255,.08)}',
    '.top-nav a.active{color:#000;background:#fff;font-weight:700}',
    '.top-nav .tn-spacer{flex:1}',
    '.top-nav .tn-updated{font-size:11px;color:#555}',
    '.top-nav .tn-sep{width:1px;height:28px;background:#333;margin:0 12px;flex-shrink:0}',
    '.top-nav .tn-review{font-size:12px;font-weight:600;color:#94a3b8;text-decoration:none;padding:6px 14px;border-radius:6px;transition:all .15s;white-space:nowrap;border:1px solid #333;background:transparent}',
    '.top-nav .tn-review:hover{color:#fff;border-color:#555;background:rgba(255,255,255,.04)}',
    '.top-nav .tn-review.active{color:#CDE453;border-color:#CDE453;background:rgba(205,228,83,.08)}',
    '.top-nav .tn-review .tn-rv-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#CDE453;margin-right:6px}',
    '@media(max-width:700px){.top-nav{padding:0 16px;height:auto;flex-wrap:wrap;gap:8px;padding:10px 16px}.top-nav .tn-title{font-size:13px;margin-right:0;width:100%}.top-nav .tn-pills{width:100%}.top-nav .tn-sep{display:none}.top-nav .tn-review{margin-top:4px}}',
  ].join('\n');
  document.head.appendChild(style);

  var nav = document.createElement('nav');
  nav.className = 'top-nav';

  var path = window.location.pathname;
  var isSales = path.indexOf('/sales') === 0;
  var isReview = path.indexOf('/review') === 0;
  var isConversions = !isSales && !isReview && (path === '/' || path === '/index.html' || path === '');

  nav.innerHTML = [
    '<img src="https://cdn.shopify.com/s/files/1/1070/8974/files/TSG-Logo-Roundel-Black.png?v=1772037610" class="tn-logo" alt="TSG">',
    '<span class="tn-title">The Sign Group\u2122</span>',
    '<div class="tn-pills">',
    '<a href="/sales"' + (isSales ? ' class="active"' : '') + '>Revenue &amp; Invoicing</a>',
    '<a href="/"' + (isConversions ? ' class="active"' : '') + '>Sales Performance</a>',
    '</div>',
    '<div class="tn-sep"></div>',
    '<a href="/review" class="tn-review' + (isReview ? ' active' : '') + '"><span class="tn-rv-dot"></span>' + prevMonthName + ' Review</a>',
    '<div class="tn-spacer"></div>',
    '<span class="tn-updated" id="navUpdated"></span>',
  ].join('');

  document.body.insertBefore(nav, document.body.firstChild);
})();
