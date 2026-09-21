/*
 * twisty.js - category / section twisties for the Domino-style views.
 * Progressive enhancement only: every page works without JavaScript
 * (CollapseView / ExpandView URL commands do the same thing server-side).
 */
(function () {
  'use strict';

  function setTwisty(link, expanded) {
    link.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    link.innerHTML = expanded ? '&#9660;' : '&#9654;';
  }

  function toggleCategory(link, target) {
    var expanded = link.getAttribute('aria-expanded') !== 'false';
    var rows = document.querySelectorAll('tr.cat-' + target);
    for (var i = 0; i < rows.length; i += 1) {
      if (expanded) {
        rows[i].setAttribute('hidden', '');
      } else {
        rows[i].removeAttribute('hidden');
      }
    }
    setTwisty(link, !expanded);
  }

  function toggleElement(link, el) {
    var hidden = el.hasAttribute('hidden');
    if (hidden) {
      el.removeAttribute('hidden');
    } else {
      el.setAttribute('hidden', '');
    }
    setTwisty(link, hidden);
  }

  document.addEventListener('click', function (ev) {
    var link = ev.target.closest ? ev.target.closest('a.twisty') : null;
    if (!link) {
      return;
    }
    ev.preventDefault();
    var target = link.getAttribute('data-target');
    if (!target) {
      return;
    }
    var el = document.getElementById(target);
    if (el) {
      toggleElement(link, el);
    } else {
      toggleCategory(link, target);
    }
  });

  // Response-hierarchy twisties: collapse the response rows that follow a parent row.
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('a.respTwisty') : null;
    if (!t) {
      return;
    }
    ev.preventDefault();
    var row = t.closest('tr');
    var next = row.nextElementSibling;
    var collapse = t.getAttribute('aria-expanded') !== 'false';
    while (next && next.classList.contains('respRow')) {
      if (collapse) {
        next.setAttribute('hidden', '');
      } else {
        next.removeAttribute('hidden');
      }
      next = next.nextElementSibling;
    }
    setTwisty(t, !collapse);
  });
}());
