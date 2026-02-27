// nav.js — Shared navigation bar for TSG dashboards
// Add <script src="/nav.js"></script> right after <body> in any page
(function(){
  var style = document.createElement('style');
  style.textContent = [
    '.top-nav{background:#000;display:flex;align-items:center;padding:0 32px;height:52px;gap:6px;border-bottom:1px solid #222;font-family:Inter,-apple-system,sans-serif;z-index:9999}',
    '.top-nav .tn-logo{width:28px;height:28px;filter:invert(1) brightness(2);margin-right:12px}',
    '.top-nav a{font-size:13px;font-weight:600;color:#888;text-decoration:none;padding:6px 16px;border-radius:6px;transition:all .15s}',
    '.top-nav a:hover{color:#fff;background:rgba(255,255,255,.08)}',
    '.top-nav a.active{color:#000;background:#fff}',
    '.top-nav .tn-spacer{flex:1}',
    '.top-nav .tn-updated{font-size:11px;color:#555}',
  ].join('\n');
  document.head.appendChild(style);

  var nav = document.createElement('nav');
  nav.className = 'top-nav';

  var path = window.location.pathname;
  var isSales = path.indexOf('/sales') === 0;
  var isConversions = path === '/' || path === '/index.html' || path === '';

  nav.innerHTML = [
    '<img src="https://cdn.shopify.com/s/files/1/1070/8974/files/TSG-Logo-Roundel-Black.png?v=1772037610" class="tn-logo" alt="TSG">',
    '<a href="/sales"' + (isSales ? ' class="active"' : '') + '>Sales Dashboard</a>',
    '<a href="/"' + (isConversions ? ' class="active"' : '') + '>TSG Conversions</a>',
    '<div class="tn-spacer"></div>',
    '<span class="tn-updated" id="navUpdated"></span>',
  ].join('');

  document.body.insertBefore(nav, document.body.firstChild);
})();
