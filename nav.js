// nav.js — Shared navigation bar for TSG dashboards
// Add <script src="/nav.js"></script> right after <body> in any page
(function(){
  var now = new Date();
  var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var prevMonthName = pm.toLocaleString('en-GB', { month: 'short' });

  // Relative time helper — exposed globally for pages to use
  window.relativeTime = function(date) {
    var diff = Math.floor((new Date() - date) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    if (diff < 172800) return 'yesterday';
    return Math.floor(diff/86400) + 'd ago';
  };

  // Populate timestamp — called by each page after data loads
  window.setNavTimestamp = function(dateObj) {
    var el = document.getElementById('navUpdated');
    if (!el) return;
    var abs = dateObj.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    var rel = window.relativeTime(dateObj);
    el.innerHTML = '<span class="tn-upd-rel">' + rel + '</span><span class="tn-upd-abs">' + abs + '</span>';
    // Re-run every minute
    clearInterval(window._navTsInterval);
    window._navTsInterval = setInterval(function(){
      el.innerHTML = '<span class="tn-upd-rel">' + window.relativeTime(dateObj) + '</span><span class="tn-upd-abs">' + abs + '</span>';
    }, 60000);
  };

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
    '.top-nav .tn-updated{display:flex;align-items:center;gap:6px;font-size:11px;color:#666;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:4px 10px}',
    '.top-nav .tn-upd-rel{color:#60a5fa;font-weight:700;font-size:12px}',
    '.top-nav .tn-upd-abs{color:#555;font-size:10px}',
    '.top-nav .tn-sep{width:1px;height:28px;background:#333;margin:0 12px;flex-shrink:0}',
    '.top-nav .tn-review{font-size:12px;font-weight:600;color:#94a3b8;text-decoration:none;padding:6px 14px;border-radius:6px;transition:all .15s;white-space:nowrap;border:1px solid #333;background:transparent}',
    '.top-nav .tn-review:hover{color:#fff;border-color:#555;background:rgba(255,255,255,.04)}',
    '.top-nav .tn-review.active{color:#CDE453;border-color:#CDE453;background:rgba(205,228,83,.08)}',
    '.top-nav .tn-review .tn-rv-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#CDE453;margin-right:6px}',
    '@media(max-width:700px){.top-nav{padding:10px 16px;height:auto;flex-wrap:wrap;gap:8px}.top-nav .tn-title{font-size:13px;margin-right:0;width:100%}.top-nav .tn-pills{width:100%}.top-nav .tn-sep{display:none}.top-nav .tn-review{margin-top:4px}.top-nav .tn-updated{margin-top:4px;width:100%;justify-content:center}}',
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
    '<span class="tn-updated" id="navUpdated">\u23F3 Loading\u2026</span>',
  ].join('');

  document.body.insertBefore(nav, document.body.firstChild);
})();
