document.addEventListener('DOMContentLoaded', () => {

  // ── CSRF: intercept all form submissions and send token as X-CSRF-Token header ──
  // Custom headers require a CORS preflight which browsers block cross-origin,
  // making the header the unforgeable proof of same-origin.
  document.querySelectorAll('form[method="POST"], form[method="post"]').forEach(form => {
    form.addEventListener('submit', function(e) {
      // Check data-confirm before anything else
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
        e.preventDefault();
        return;
      }

      e.preventDefault();

      const token = getCsrfToken();
      if (!token) return; // no CSRF token on page — let native submit handle it

      // Use URLSearchParams for urlencoded forms, FormData for multipart (file uploads)
      const isMultipart = form.enctype === 'multipart/form-data';
      const body = isMultipart
        ? new FormData(form)
        : new URLSearchParams(new FormData(form));

      fetch(form.action || window.location.href, {
        method: 'POST',
        headers: isMultipart
          ? { 'X-CSRF-Token': token }
          : { 'X-CSRF-Token': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'same-origin',
      }).then(res => {
        if (res.redirected) { window.location.href = res.url; return; }
        return res.text().then(html => {
          document.open(); document.write(html); document.close();
          window.history.replaceState({}, '', res.url || window.location.href);
        });
      }).catch(() => {
        // Network error — fall back to native submit
        form.submit();
      });
    });
  });

  // ── Auto-dismiss alerts ──────────────────────────────────────────────────
  document.querySelectorAll('.alert-success, .alert-info').forEach(el => {
    setTimeout(() => {
      el.style.transition = 'opacity 0.5s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    }, 5000);
  });

  // ── data-confirm on non-form elements (buttons, links) ───────────────────
  document.querySelectorAll('[data-confirm]:not(form)').forEach(el => {
    el.addEventListener('click', e => {
      if (!confirm(el.dataset.confirm)) e.preventDefault();
    });
  });

  // ── data-open-url: card click opens URL ──────────────────────────────────
  document.querySelectorAll('[data-open-url]').forEach(el => {
    el.addEventListener('click', () => window.open(el.dataset.openUrl));
  });

  // ── data-stop-propagation: prevent bubbling ───────────────────────────────
  document.querySelectorAll('[data-stop-propagation]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });

  // ── Banner file preview ───────────────────────────────────────────────────
  document.querySelectorAll('.file-input[data-preview]').forEach(input => {
    input.addEventListener('change', () => previewBanner(input));
  });

  // ── Drag-and-drop on upload areas ─────────────────────────────────────────
  const area = document.getElementById('upload-area');
  if (area) {
    area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('drag-over'); });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', e => {
      e.preventDefault();
      area.classList.remove('drag-over');
      const input = area.querySelector('.file-input');
      if (input && e.dataTransfer.files.length) {
        try { input.files = e.dataTransfer.files; } catch(err) {}
        previewBanner(input);
      }
    });
  }

  // ── Description char counter ──────────────────────────────────────────────
  const desc = document.getElementById('description');
  const counter = document.getElementById('desc-count');
  if (desc && counter) {
    desc.addEventListener('input', () => {
      counter.textContent = desc.value.length + ' / 2000';
    });
  }

  // ── Guidelines live preview ────────────────────────────────────────────────
  const guidelinesInput = document.getElementById('guidelines-input');
  if (guidelinesInput && typeof marked !== 'undefined') {
    guidelinesInput.addEventListener('input', () => updatePreview(guidelinesInput.value));
  }

  // ── Tag input hint ────────────────────────────────────────────────────────
  const tagInput = document.getElementById('tags');
  if (tagInput) {
    tagInput.addEventListener('input', () => {
      const tags = tagInput.value.split(',').map(t => t.trim()).filter(Boolean);
      tagInput.title = tags.length ? tags.length + ' tag(s): ' + tags.join(', ') : '';
    });
  }

});

// ── getCsrfToken: reads from meta tag set server-side ────────────────────────
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : '';
}

// ── Banner preview ────────────────────────────────────────────────────────────
function previewBanner(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => {
      const preview = document.getElementById('banner-preview');
      const placeholder = document.getElementById('upload-placeholder');
      if (preview) { preview.src = e.target.result; preview.classList.remove('hidden'); }
      if (placeholder) placeholder.classList.add('hidden');
    };
    reader.readAsDataURL(input.files[0]);
  }
}

// ── Guidelines preview ────────────────────────────────────────────────────────
function updatePreview(md) {
  const el = document.getElementById('guidelines-preview');
  const counter = document.getElementById('char-count');
  if (el && typeof marked !== 'undefined') el.innerHTML = marked.parse(md || '');
  if (counter) counter.textContent = (md || '').length + ' / 20000';
}