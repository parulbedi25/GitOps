/* ShopStack storefront — progressive enhancement.
   Every interaction below also works without JavaScript: the forms POST to the
   server and the server redirects. This file only makes it feel instant. */
(function () {
  'use strict';

  const badge = document.querySelector('[data-cart-count]');

  function setCartCount(count) {
    if (!badge) return;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    badge.animate?.(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.35)' },
        { transform: 'scale(1)' },
      ],
      { duration: 260, easing: 'ease-out' },
    );
  }

  function toast(message) {
    let host = document.querySelector('.ss-toast');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ss-toast';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      host.style.cssText =
        'position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%) translateY(8px);' +
        'background:#16130f;color:#fbf9f5;padding:.7rem 1.1rem;border-radius:999px;' +
        'font-size:.85rem;box-shadow:0 12px 30px -12px rgba(0,0,0,.5);opacity:0;' +
        'transition:opacity .2s ease,transform .2s ease;z-index:60;pointer-events:none';
      document.body.appendChild(host);
    }
    host.textContent = message;
    requestAnimationFrame(() => {
      host.style.opacity = '1';
      host.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(host._timer);
    host._timer = setTimeout(() => {
      host.style.opacity = '0';
      host.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2200);
  }

  // Quantity steppers (product page + cart rows).
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-qty-step]');
    if (!button) return;
    event.preventDefault();
    const wrap = button.closest('.qty');
    const input = wrap && wrap.querySelector('input');
    if (!input) return;
    const step = Number(button.dataset.qtyStep || 1);
    const min = Number(input.min || 1);
    const max = Number(input.max || 20);
    const next = Math.min(max, Math.max(min, Number(input.value || 1) + step));
    input.value = String(next);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Add-to-cart forms: submit in the background and update the badge.
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-add-to-cart]');
    if (!form) return;
    event.preventDefault();

    const submit = form.querySelector('button[type="submit"]');
    const original = submit ? submit.innerHTML : null;
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = 'Adding…';
    }

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      setCartCount(payload.itemCount ?? 0);
      toast(payload.message || 'Added to your bag');
    } catch (error) {
      // Fall back to a full page submission so the customer is never stuck.
      form.removeAttribute('data-add-to-cart');
      form.submit();
      return;
    } finally {
      if (submit) {
        submit.disabled = false;
        if (original !== null) submit.innerHTML = original;
      }
    }
  });

  // Auto-submit quantity changes on the cart page.
  document.addEventListener('change', (event) => {
    const input = event.target.closest('form[data-qty-form] input[name="quantity"]');
    if (!input) return;
    input.closest('form').requestSubmit();
  });
})();
