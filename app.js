(function(){
  "use strict";
  var doc = document, root = doc.documentElement, body = doc.body;
  var content   = doc.getElementById("content");
  var empty     = doc.getElementById("empty");
  var fileInput = doc.getElementById("fileInput");
  var overlay   = doc.getElementById("dropOverlay");
  var toastEl   = doc.getElementById("toast");
  var docTitle  = doc.getElementById("docTitle");
  var bgPicker  = doc.getElementById("bgPicker");
  var themeColor= doc.getElementById("themeColor");
  var footerEl  = doc.getElementById("footer");
  var topbar    = doc.querySelector(".topbar");
  var urlError      = doc.getElementById("urlError");
  var urlErrorTitle = doc.getElementById("urlErrorTitle");
  var urlErrorMsg   = doc.getElementById("urlErrorMsg");
  var urlRetryBtn   = doc.getElementById("urlRetryBtn");
  var urlDismissBtn = doc.getElementById("urlDismissBtn");
  var emptyTitle    = doc.querySelector(".empty-title");
  var emptySub      = doc.querySelector(".empty-sub");
  var DEFAULT_EMPTY_TITLE = "Drop a Markdown file to view";
  var DEFAULT_EMPTY_SUB   = "Drag & drop anywhere, paste, or tap to open. Accepts .md, .markdown, .mdx, .txt, .rst, .adoc.";
  var rawText   = "";
  var toastTimer = null;
  var BASE_TITLE = "Markdown Viewer";
  var isReadonly = false;
  var activeFetchController = null;
  var activeUrl = "";

  // Accepted Markdown-family file types (other file types are handled elsewhere).
  var MD_EXT = ["md", "markdown", "mdx", "txt", "rst", "adoc"];
  function extOf(name){ var m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
  function isAccepted(name){ return MD_EXT.indexOf(extOf(name)) !== -1; }

  if (window.marked && typeof marked.setOptions === "function") {
    marked.setOptions({ gfm: true, breaks: false });
  }

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove("show"); }, 2200);
  }

  // Reflect the loaded file's name into the URL (?name=), so a bookmarked or
  // shared link says what was being viewed. history.replaceState only, and
  // URLSearchParams does its own percent-encoding — this never touches the
  // DOM, so it carries no XSS risk on its own. The value becomes untrusted
  // input again the moment it is read back (see the on-load block near the
  // bottom of this script), and that path must stay textContent-only.
  function syncQueryName(name){
    var url = new URL(location.href);
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function render(text, title, docUrl){
    rawText = text;
    syncQueryName(title);             // "" from the two paste handlers — pasted text has no file
    var html = window.marked ? marked.parse(text) : text;
    if (window.DOMPurify) html = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
    content.innerHTML = html;
    var links = content.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++){
      var href = links[i].getAttribute("href") || "";
      if (!href.startsWith("#")){
        links[i].setAttribute("target", "_blank");
        links[i].setAttribute("rel", "noopener noreferrer");
      }
    }
    if (docUrl){
      try {
        var baseUrl = new URL("./", docUrl).href;
        var imgs = content.querySelectorAll('img[src]');
        for (var j = 0; j < imgs.length; j++){
          var src = imgs[j].getAttribute("src");
          if (src && !/^(?:[a-z]+:|\/\/|data:|blob:)/i.test(src)){
            imgs[j].src = new URL(src, baseUrl).href;
          }
        }
        for (var k = 0; k < links.length; k++){
          var linkHref = links[k].getAttribute("href") || "";
          if (linkHref && !linkHref.startsWith("#") && !/^(?:[a-z]+:|\/\/|mailto:|tel:)/i.test(linkHref)){
            var resolved = new URL(linkHref, baseUrl).href;
            var cleanPath = resolved.split("?")[0].split("#")[0];
            if (isAccepted(cleanPath)){
              links[k].setAttribute("href", "#url=" + encodeURIComponent(resolved));
              links[k].removeAttribute("target");
              links[k].removeAttribute("rel");
            } else {
              links[k].setAttribute("href", resolved);
              links[k].setAttribute("target", "_blank");
              links[k].setAttribute("rel", "noopener noreferrer");
            }
          }
        }
      } catch (_) {}
    }
    content.hidden = false;
    empty.hidden = true;
    if (urlError) urlError.hidden = true;
    docTitle.textContent = title || BASE_TITLE;
    doc.title = title ? title + " — " + BASE_TITLE : BASE_TITLE;
    body.classList.add("viewing");
    lastY = 0;
    window.scrollTo(0, 0);
    revealHeader();                          // header visible on open, collapses to the handle after 3s
  }

  function clearAll(){
    if (activeFetchController){
      activeFetchController.abort();
      activeFetchController = null;
    }
    activeUrl = "";
    isReadonly = false;
    body.classList.remove("readonly-mode");
    rawText = "";
    syncQueryName("");
    content.innerHTML = "";
    content.hidden = true;
    if (urlError) urlError.hidden = true;
    empty.hidden = false;
    empty.style.pointerEvents = "";
    if (emptyTitle) emptyTitle.textContent = DEFAULT_EMPTY_TITLE;
    if (emptySub) emptySub.textContent = DEFAULT_EMPTY_SUB;
    docTitle.textContent = BASE_TITLE;
    doc.title = BASE_TITLE;
    body.classList.remove("viewing", "header-hidden");
    clearTimeout(headerTimer);
  }

  function readFile(file){
    if (!file) return;
    if (!isAccepted(file.name)){
      var e = extOf(file.name);
      if (!familyRoute(file)) toast("Unsupported file type" + (e ? ": ." + e : ""));  // §6.10: offer a sibling viewer first
      return;
    }
    var reader = new FileReader();
    reader.onload  = function(ev){ render(String(ev.target.result || ""), file.name); };
    reader.onerror = function(){ toast("Could not read that file"); };
    reader.readAsText(file);
  }

  function openDialog(){ fileInput.click(); }

  fileInput.addEventListener("change", function(e){
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    fileInput.value = "";
  });

  // Copy the raw source
  doc.getElementById("btnCopy").addEventListener("click", function(){
    if (!rawText){ toast("Nothing to copy yet"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(rawText).then(
        function(){ toast("Copied"); },
        function(){ fallbackCopy(rawText); }
      );
    } else {
      fallbackCopy(rawText);
    }
  });
  function fallbackCopy(text){
    var ta = doc.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.opacity = "0";
    doc.body.appendChild(ta); ta.select();
    try { doc.execCommand("copy"); toast("Copied"); }
    catch (err){ toast("Copy not supported"); }
    doc.body.removeChild(ta);
  }

  doc.getElementById("btnClear").addEventListener("click", function(){
    if (!isReadonly) clearAll();
  });

  // Empty-state acts as an open button (great on mobile)
  empty.addEventListener("click", function(){
    if (!isReadonly) openDialog();
  });
  empty.addEventListener("keydown", function(e){
    if (isReadonly) return;
    if (e.key === "Enter" || e.key === " "){ e.preventDefault(); openDialog(); }
  });

  // Footer close (session)
  doc.getElementById("footerClose").addEventListener("click", function(){ footerEl.hidden = true; });

  // ---------- Family nav (hamburger flyout) ----------
  var btnMenu = doc.getElementById("btnMenu"), navBackdrop = doc.getElementById("navBackdrop");
  function setNav(open){ body.classList.toggle("nav-open", open); btnMenu.setAttribute("aria-expanded", open ? "true" : "false"); }
  btnMenu.addEventListener("click", function(){ setNav(!body.classList.contains("nav-open")); });
  navBackdrop.addEventListener("click", function(){ setNav(false); });
  doc.addEventListener("keydown", function(e){
    if (!doc.getElementById("routeCard").hidden){   // route card is modal (§6.10): Escape dismisses, Tab cycles its two buttons
      if (e.key === "Escape"){ hideRouteCard(); return; }
      if (e.key === "Tab"){
        e.preventDefault();
        var go = doc.getElementById("routeGo"), no = doc.getElementById("routeDismiss");
        (doc.activeElement === go || go.disabled ? no : go).focus();
        return;
      }
    }
    if (e.key === "Escape") setNav(false);
  });

  // ---------- Header: while viewing, auto-hides after 3s (collapses to a thick handle); ----------
  // ---------- hover / touch / scroll-up brings it back. ----------
  var lastY = 0, headerTimer = null, ticking = false;
  function showHeader(){ body.classList.remove("header-hidden"); }
  function hideHeader(){ if (body.classList.contains("viewing")) body.classList.add("header-hidden"); }
  function armIdleHide(){ clearTimeout(headerTimer); headerTimer = setTimeout(hideHeader, 3000); }
  function revealHeader(){ showHeader(); armIdleHide(); }
  function _showHeaderSoon(){ revealHeader(); }   // (compat) show now, then auto-hide after 3s
  function onScroll(){
    ticking = false;
    if (!body.classList.contains("viewing")) return;
    var y = window.pageYOffset || root.scrollTop || 0;
    var dy = y - lastY;
    lastY = y;
    if (dy > 4) hideHeader();          // scrolling down -> collapse to the handle
    else if (dy < -4) revealHeader();  // scrolling up   -> reveal, then auto-hide after 3s
  }
  window.addEventListener("scroll", function(){
    if (!ticking){ ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  // reveal via the top strip / handle (hover, tap, click); keep it up while the pointer is on the header
  var hoverZone = doc.getElementById("hoverZone");
  if (hoverZone){
    hoverZone.addEventListener("mouseenter", revealHeader);
    hoverZone.addEventListener("click", revealHeader);
    hoverZone.addEventListener("touchstart", function(){ revealHeader(); }, { passive:true });
  }
  if (topbar){
    topbar.addEventListener("mouseenter", function(){ showHeader(); clearTimeout(headerTimer); });
    topbar.addEventListener("mouseleave", function(){ armIdleHide(); });
  }

  // ---------- Background color (remembered in a cookie, with a localStorage fallback) ----------
  function setCookie(name, val){
    doc.cookie = name + "=" + encodeURIComponent(val) + "; max-age=31536000; path=/; SameSite=Lax";
  }
  function getCookie(name){
    var m = doc.cookie.match("(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : null;
  }
  function hexToRgb(h){
    h = h.replace("#", "");
    if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    var n = parseInt(h, 16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }
  function srgb(c){ c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
  function luminance(rgb){ return 0.2126*srgb(rgb.r) + 0.7152*srgb(rgb.g) + 0.0722*srgb(rgb.b); }
  function mix(a, b, t){
    return "rgb(" + Math.round(a.r+(b.r-a.r)*t) + "," + Math.round(a.g+(b.g-a.g)*t) + "," + Math.round(a.b+(b.b-a.b)*t) + ")";
  }
  function rgbStr(c){ return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }
  function applyColor(hex){
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) hex = "#ffffff";
    var bg = hexToRgb(hex);
    var lightText = luminance(bg) <= 0.179;
    var text = lightText ? { r:240, g:243, b:246 } : { r:31, g:35, b:40 };
    var accentHex = lightText ? "#8b93ff" : "#4f46e5";
    var ac = hexToRgb(accentHex);
    var s = root.style;
    s.setProperty("--bg", hex);
    s.setProperty("--surface", hex);
    s.setProperty("--text", rgbStr(text));
    s.setProperty("--code-text", rgbStr(text));
    s.setProperty("--muted", mix(bg, text, 0.45));
    s.setProperty("--border", mix(bg, text, 0.24));
    s.setProperty("--border-soft", mix(bg, text, 0.13));
    s.setProperty("--code-bg", mix(bg, text, 0.07));
    s.setProperty("--hover", mix(bg, text, 0.10));
    s.setProperty("--table-stripe", mix(bg, text, 0.05));
    s.setProperty("--quote-border", mix(bg, text, 0.26));
    s.setProperty("--accent", accentHex);
    s.setProperty("--accent-contrast", lightText ? "#0d1117" : "#ffffff");
    s.setProperty("--overlay", "rgba(" + ac.r + "," + ac.g + "," + ac.b + ",0.12)");
    s.setProperty("--shadow", lightText ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.12)");
    s.setProperty("--header-bg", "rgba(" + bg.r + "," + bg.g + "," + bg.b + ",0.9)");
    s.colorScheme = lightText ? "dark" : "light";
    themeColor.setAttribute("content", hex);
  }
  function isHex6(v){ return /^#([0-9a-f]{6})$/i.test(v || ""); }
  function saveColor(val){ setCookie("mykk-bg", val); try { localStorage.setItem("mykk-bg", val); } catch (e) {} }
  function loadColor(){
    var v = getCookie("mykk-bg");
    if (!isHex6(v)) { try { v = localStorage.getItem("mykk-bg"); } catch (e) { v = null; } }
    return isHex6(v) ? v : ((window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "#0d1117" : "#ffffff");
  }
  var saved = loadColor();
  bgPicker.value = saved;
  applyColor(saved);
  bgPicker.addEventListener("input", function(){
    applyColor(bgPicker.value);
    saveColor(bgPicker.value);
    syncThemeToggle();
  });
  var themeToggle=doc.getElementById("themeToggle"),themeIconSun=doc.getElementById("themeIconSun"),themeIconMoon=doc.getElementById("themeIconMoon");
  function isDarkBg(){ try { return luminance(hexToRgb(bgPicker.value)) <= 0.179; } catch(e){ return false; } }
  function syncThemeToggle(){ if(!themeToggle) return; var dark=isDarkBg(); themeToggle.setAttribute("aria-pressed", dark?"true":"false"); themeToggle.setAttribute("aria-label", dark?"Switch to light theme":"Switch to dark theme"); if(themeIconSun){ if(dark) themeIconSun.setAttribute("hidden",""); else themeIconSun.removeAttribute("hidden"); } if(themeIconMoon){ if(dark) themeIconMoon.removeAttribute("hidden"); else themeIconMoon.setAttribute("hidden",""); } }
  if(themeToggle){ themeToggle.addEventListener("click", function(){ var next=isDarkBg()?"#ffffff":"#0d1117"; bgPicker.value=next; applyColor(next); saveColor(next); syncThemeToggle(); }); }
  syncThemeToggle();

  // ---------- Drag & drop (anywhere) ----------
  var dragDepth = 0;
  function showOverlay(s){ overlay.classList.toggle("show", s); }
  window.addEventListener("dragenter", function(e){
    if (isReadonly) return;
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") === -1) return;
    e.preventDefault(); dragDepth++; showOverlay(true);
  });
  window.addEventListener("dragover", function(e){
    if (isReadonly) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", function(e){
    if (isReadonly) return;
    e.preventDefault(); dragDepth--; if (dragDepth <= 0){ dragDepth = 0; showOverlay(false); }
  });
  window.addEventListener("drop", function(e){
    if (isReadonly) return;
    e.preventDefault(); dragDepth = 0; showOverlay(false);
    var dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length){ readFile(dt.files[0]); return; }
    var txt = dt.getData && dt.getData("text");
    if (txt) render(txt, "");
  });

  // ---------- Paste to view ----------
  window.addEventListener("paste", function(e){
    if (isReadonly) return;
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    if (cd.files && cd.files.length){ e.preventDefault(); readFile(cd.files[0]); return; }
    var txt = cd.getData && cd.getData("text");
    if (txt){ e.preventDefault(); render(txt, ""); }
  });

  // ---------- Family router (§6.10): wrong-viewer redirect offer + in-browser hand-off ----------
  // Data block copied byte-for-byte from the hub (file-viewer.us index.html);
  // canonical source is family-map.json in the hub repo. Deep-equality is
  // enforced by the harness (§6.10 governance).
  function id(s){ return doc.getElementById(s); }
        /* FV-MAP-START — generated from family-map.json (canonical); deep-equality enforced by the harness */
    var FAMILY = {
      audio:    { domain:"audio-viewer.us"     , label:"Audio Viewer"     , kind:"an audio file" },
      cert:     { domain:"cert-viewer.us"      , label:"Cert Viewer"      , kind:"a certificate" },
      data:     { domain:"data-viewer.us"      , label:"Data Viewer"      , kind:"a data file" },
      docx:     { domain:"docx-viewer.us"      , label:"DOCX Viewer"      , kind:"a Word document" },
      eml:      { domain:"eml-viewer.us"       , label:"EML Viewer"       , kind:"an email file" },
      epub:     { domain:"epub-viewer.us"      , label:"EPUB Viewer"      , kind:"an e-book" },
      html:     { domain:"html-viewer.us"      , label:"HTML Viewer"      , kind:"a web or source-code file" },
      image:    { domain:"image-viewer.us"     , label:"Image Viewer"     , kind:"an image" },
      log:      { domain:"log-viewer.us"       , label:"Log Viewer"       , kind:"a log file" },
      markdown: { domain:"markdown-viewer.us"  , label:"Markdown Viewer"  , kind:"a Markdown or text file" },
      pdf:      { domain:"pdf-viewer.us"       , label:"PDF Viewer"       , kind:"a PDF" },
      pptx:     { domain:"pptx-viewer.us"      , label:"PPTX Viewer"      , kind:"a presentation" },
      pub:      { domain:"pub-viewer.us"       , label:"PUB Viewer"       , kind:"a Publisher file" },
      sheets:   { domain:"sheets-viewer.us"    , label:"Sheets Viewer"    , kind:"a spreadsheet" },
      video:    { domain:"video-viewer.us"     , label:"Video Viewer"     , kind:"a video" }
    };
    var FAMILY_HUB = "file-viewer.us";
    var FAMILY_NAMES = {"robots.txt":"html"};
    var FAMILY_MAP = {
      // sheets
      "123":"sheets", xlsx:"sheets", xlsm:"sheets", xlsb:"sheets", xls:"sheets", xlt:"sheets", xltx:"sheets", xltm:"sheets",
      xlam:"sheets", ods:"sheets", fods:"sheets", dif:"sheets", prn:"sheets", dbf:"sheets", numbers:"sheets", xlml:"sheets",
      wk1:"sheets", wk3:"sheets", wks:"sheets", et:"sheets", uos:"sheets",
      // cert
      pem:"cert", crt:"cert", cer:"cert", der:"cert", csr:"cert", cert:"cert", p7b:"cert", p12:"cert",
      pfx:"cert",
      // data
      json:"data", jsonc:"data", json5:"data", jsonld:"data", ndjson:"data", yaml:"data", yml:"data", toml:"data",
      csv:"data", tsv:"data", xml:"data", rss:"data", atom:"data", graphql:"data", gql:"data",
      // docx
      docx:"docx", docm:"docx", dotx:"docx", dotm:"docx", doc:"docx", dot:"docx", rtf:"docx", odt:"docx",
      // eml
      eml:"eml", mbox:"eml", emlx:"eml", msg:"eml",
      // epub
      epub:"epub",
      // html
      html:"html", htm:"html", xhtml:"html", xht:"html", shtml:"html", shtm:"html", stm:"html", hta:"html",
      mhtml:"html", mht:"html", css:"html", scss:"html", sass:"html", less:"html", styl:"html", pcss:"html",
      postcss:"html", js:"html", mjs:"html", cjs:"html", jsx:"html", ts:"html", mts:"html", cts:"html",
      tsx:"html", coffee:"html", htaccess:"html", htpasswd:"html", env:"html", ini:"html", conf:"html", webmanifest:"html",
      map:"html", php:"html", phtml:"html", asp:"html", aspx:"html", ascx:"html", cshtml:"html", vbhtml:"html",
      jsp:"html", jspx:"html", cfm:"html", erb:"html", rhtml:"html", ejs:"html", hbs:"html", handlebars:"html",
      mustache:"html", njk:"html", liquid:"html", jinja:"html", j2:"html", twig:"html", pug:"html", jade:"html",
      haml:"html", slim:"html", vue:"html", svelte:"html", astro:"html",
      // image
      png:"image", jpg:"image", jpeg:"image", jpe:"image", jfif:"image", gif:"image", webp:"image", avif:"image",
      svg:"image", svgz:"image", bmp:"image", dib:"image", ico:"image", cur:"image", tif:"image", tiff:"image",
      tga:"image", targa:"image", icb:"image", vda:"image", vst:"image", qoi:"image", pcx:"image", ppm:"image",
      pgm:"image", pbm:"image", pnm:"image", pam:"image", ff:"image", dds:"image", heic:"image", heif:"image",
      jxl:"image", psd:"image",
      // log
      log:"log", out:"log", err:"log", trace:"log", syslog:"log",
      // markdown
      md:"markdown", markdown:"markdown", mdx:"markdown", txt:"markdown", rst:"markdown", adoc:"markdown",
      // pdf
      pdf:"pdf",
      // pptx
      pptx:"pptx", pptm:"pptx", ppsx:"pptx", ppsm:"pptx", potx:"pptx", potm:"pptx", ppt:"pptx",
      // pub
      pub:"pub",
      // audio
      mp3:"audio", wav:"audio", flac:"audio", m4a:"audio", aac:"audio", ogg:"audio", oga:"audio", opus:"audio",
      weba:"audio", mka:"audio", aif:"audio", aiff:"audio", wma:"audio", mid:"audio", midi:"audio",
      // video
      webm:"video", mp4:"video", m4v:"video", ogv:"video", mov:"video", mkv:"video", avi:"video", wmv:"video"
    };
    /* FV-MAP-END */
    var FAMILY_ORIGINS = Object.keys(FAMILY).map(function (k) { return "https://" + FAMILY[k].domain; })
      .concat("https://" + FAMILY_HUB);
  var DOMAIN = "markdown-viewer.us";

  var routeFile = null, routeKey = "", routePrevFocus = null, handoff = null;
  function cancelHandoff(){                    // tear down a pending hand-off (sender below)
    if (!handoff) return;
    window.removeEventListener("message", handoff.onMsg);
    clearTimeout(handoff.timer);
    handoff = null;
  }
  function showRouteCard(file, key){
    cancelHandoff();                           // a new offer aborts any pending hand-off
    if (id("routeCard").hidden) routePrevFocus = doc.activeElement;  // don't capture our own button
    routeFile = file; routeKey = key;
    var t = FAMILY[key];
    // ⁨…⁩ (FSI…PDI) bidi-isolate the untrusted name so U+202E-style
    // overrides can't visually reorder the sentence.
    id("routeMsg").textContent = "“⁨" + file.name + "⁩” looks like " + t.kind + " — it belongs to " + t.label + ".";
    id("routeGo").textContent = "Open " + t.domain + " ↗";
    id("routeSub").textContent = "Your file stays on this device — nothing is uploaded.";
    id("routeGo").disabled = false;
    id("routeBackdrop").hidden = false; id("routeCard").hidden = false;
    id("routeGo").focus();
  }
  function hideRouteCard(){
    cancelHandoff();                           // dismissal aborts a pending hand-off
    id("routeBackdrop").hidden = true; id("routeCard").hidden = true;
    routeFile = null; routeKey = "";
    if (routePrevFocus && routePrevFocus.focus) routePrevFocus.focus();
  }
  function familyRoute(file){
    var n = String(file && file.name || "").toLowerCase();
    var key = FAMILY_NAMES[n];
    if (!key){
      var i = n.lastIndexOf(".");
      var ext = i >= 0 ? n.slice(i + 1) : "";
      key = FAMILY_MAP[ext];
    }
    if (!key || FAMILY[key].domain === DOMAIN) return false;  // unknown type, or our own type -> caller keeps its toast
    showRouteCard(file, key);
    return true;
  }

  // Sender — the routeGo click is a real user gesture, so no popup blocker.
  // Keep the window handle: it IS the message channel (trusted family only);
  // the receiver never touches window.opener except for the ready ping.
  id("routeGo").addEventListener("click", function(){
    if (!routeFile || id("routeGo").disabled) return;               // no double-fire
    cancelHandoff();
    var t = FAMILY[routeKey], origin = "https://" + t.domain, file = routeFile;
    var w = window.open(origin + "/#fvh=" + encodeURIComponent(file.name));
    if (!w){ id("routeSub").textContent = "Couldn’t open the tab — allow pop-ups for this site and try again."; return; }
    id("routeGo").disabled = true;
    var h = {};
    h.onMsg = function(e){
      if (e.source !== w || e.origin !== origin || !e.data) return;
      if (e.data.type === "fv-ready") w.postMessage({ type:"fv-file", file:file }, origin);
      else if (e.data.type === "fv-ack"){ hideRouteCard(); toast("Sent to " + t.label); }  // hideRouteCard tears the handshake down
    };
    h.timer = setTimeout(function(){
      if (handoff !== h) return;
      cancelHandoff();
      id("routeSub").textContent = "Tab opened — drop the file there.";   // Level-1 fallback
    }, 10000);
    handoff = h;
    window.addEventListener("message", h.onMsg);
  });
  id("routeDismiss").addEventListener("click", hideRouteCard);
  id("routeBackdrop").addEventListener("click", hideRouteCard);

  // Receiver — a sibling tab (or the hub) hands a File across via postMessage
  // structured clone: in-browser, never on the wire.
  window.addEventListener("message", function(e){
    if (FAMILY_ORIGINS.indexOf(e.origin) === -1) return;      // family origins only
    var d = e.data;
    if (d && d.type === "fv-file" && d.file instanceof File){ // clone re-creates a real File in this realm
      readFile(d.file);
      e.source.postMessage({ type:"fv-ack" }, e.origin);      // ack = received and handed to the loader
    }
  });
  var fvh = /[#&]fvh=([^&]*)/.exec(location.hash);
  if (fvh){
    var fvhName = fvh[1];                                   // ⚠️ stranger-controlled — textContent only
    try { fvhName = decodeURIComponent(fvhName); } catch (_) {}  // malformed %-escapes must not abort the receiver
    history.replaceState(null, "", location.pathname + location.search);  // always clear, opener or not
    if (window.opener){
      try { window.opener.postMessage({ type:"fv-ready" }, "*"); } catch(_){}
      window.opener = null;    // sever the reverse-navigation channel once the ping is out
      if (emptySub){
        var emptySubText = emptySub.textContent;
        emptySub.textContent = "Receiving “⁨" + fvhName + "⁩”…";
        setTimeout(function(){ emptySub.textContent = emptySubText; }, 10000);  // revert if nothing arrives
      }
    }
  }

  function rewriteRepoUrl(rawUrl){
    if (!rawUrl) return "";
    var url = rawUrl.trim();
    // GitHub blob: https://github.com/:owner/:repo/blob/:ref/:path
    var gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(url);
    if (gh){
      return "https://raw.githubusercontent.com/" + gh[1] + "/" + gh[2] + "/" + gh[3] + "/" + gh[4];
    }
    // GitLab blob: https://gitlab.com/:owner/:repo/-/blob/:ref/:path
    var gl = /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/([^/]+)\/(.+)$/i.exec(url);
    if (gl){
      return "https://gitlab.com/" + gl[1] + "/" + gl[2] + "/-/raw/" + gl[3] + "/" + gl[4];
    }
    // Gist: https://gist.github.com/:user/:id (without /raw)
    var gist = /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)(?:\/)?$/i.exec(url);
    if (gist){
      return "https://gist.githubusercontent.com/" + gist[1] + "/" + gist[2] + "/raw";
    }
    return url;
  }

  function titleFromUrl(u){
    try {
      var pathname = new URL(u).pathname;
      var segs = pathname.split("/").filter(Boolean);
      var last = segs.length ? segs[segs.length - 1] : "";
      return decodeURIComponent(last) || BASE_TITLE;
    } catch (_) {
      return BASE_TITLE;
    }
  }

  function getHashUrl(){
    var h = location.hash || "";
    if (h.indexOf("#url=") === 0){
      var val = h.slice(5);
      try { val = decodeURIComponent(val); } catch (_) {}
      return val;
    }
    var m = /[#&]url=([^&]*)/.exec(h);
    if (!m) return null;
    var raw = m[1];
    try { raw = decodeURIComponent(raw); } catch (_) {}
    return raw;
  }

  function showUrlError(title, msg){
    isReadonly = true;
    body.classList.add("readonly-mode");
    empty.hidden = true;
    content.hidden = true;
    if (urlError){
      urlError.hidden = false;
      if (urlErrorTitle) urlErrorTitle.textContent = title;
      if (urlErrorMsg) urlErrorMsg.textContent = msg;
    }
    docTitle.textContent = "Error — " + BASE_TITLE;
    doc.title = "Error — " + BASE_TITLE;
  }

  function loadFromUrl(targetUrl){
    if (activeFetchController){
      activeFetchController.abort();
      activeFetchController = null;
    }
    activeUrl = targetUrl;
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)){
      showUrlError("Invalid URL", "Only http: and https: URLs are supported.", targetUrl);
      return;
    }
    var fetchUrl = rewriteRepoUrl(targetUrl);
    var docName = titleFromUrl(targetUrl);
    isReadonly = true;
    body.classList.add("readonly-mode");
    content.hidden = true;
    if (urlError) urlError.hidden = true;
    empty.hidden = false;
    empty.style.pointerEvents = "none";
    if (emptyTitle) emptyTitle.textContent = "Fetching Markdown…";
    if (emptySub) emptySub.textContent = "Loading “⁨" + docName + "⁩” from " + targetUrl;

    var controller = new AbortController();
    activeFetchController = controller;
    var timeoutId = setTimeout(function(){ controller.abort(); }, 20000);

    fetch(fetchUrl, { signal: controller.signal })
      .then(function(res){
        clearTimeout(timeoutId);
        if (!res.ok){
          throw new Error("HTTP " + res.status + (res.statusText ? " " + res.statusText : ""));
        }
        return res.text();
      })
      .then(function(text){
        if (activeUrl !== targetUrl) return;
        empty.style.pointerEvents = "";
        render(text, docName, fetchUrl);
      })
      .catch(function(err){
        clearTimeout(timeoutId);
        if (activeUrl !== targetUrl) return;
        empty.style.pointerEvents = "";
        if (err.name === "AbortError"){
          showUrlError("Request timed out", "Fetching the remote document took longer than 20 seconds.", targetUrl);
        } else {
          var msg = err.message || "";
          var corsHint = "";
          if (!msg || msg.indexOf("Failed to fetch") !== -1 || msg.indexOf("NetworkError") !== -1){
            corsHint = " The request may have been blocked by the remote server's Cross-Origin Resource Sharing (CORS) policy, or the server is unreachable.";
          }
          showUrlError("Could not load Markdown", (msg ? msg + "." : "") + corsHint, targetUrl);
        }
      });
  }

  if (urlRetryBtn){
    urlRetryBtn.addEventListener("click", function(){
      if (activeUrl) loadFromUrl(activeUrl);
    });
  }
  if (urlDismissBtn){
    urlDismissBtn.addEventListener("click", function(){
      isReadonly = false;
      body.classList.remove("readonly-mode");
      if (urlError) urlError.hidden = true;
      empty.hidden = false;
      clearAll();
      history.replaceState(null, "", location.pathname + location.search);
    });
  }

  window.addEventListener("hashchange", function(){
    var u = getHashUrl();
    if (u){
      loadFromUrl(u);
    } else if (isReadonly){
      clearAll();
    }
  });

  // A bookmarked or shared link can carry the name of the file last viewed
  // (?name=, set by syncQueryName above). No content is ever recoverable
  // from a name alone -- this only labels the empty state, and it never
  // fetches or renders anything on the strength of it. Skipped when an
  // #fvh hand-off is already customizing the same element.
  if (!fvh && !rawText){
    var hashUrl = getHashUrl();
    if (hashUrl){
      loadFromUrl(hashUrl);
    } else {
      var qName = new URLSearchParams(location.search).get("name");
      if (qName){
        var lastSub = doc.querySelector(".empty-sub");
        if (lastSub){
          // Display-only, and it must stay that way: this string is read
          // straight from the URL, so it is exactly as stranger-controlled as
          // fvhName above. Note this element is NOT covered by the DOMPurify
          // pass in render() -- that only sanitizes #content -- so textContent
          // is the whole defense here, not a second layer behind one.
          lastSub.textContent = "This link was shared for “⁨" + qName + "⁩”.";
        }
      }
    }
  }
})();
