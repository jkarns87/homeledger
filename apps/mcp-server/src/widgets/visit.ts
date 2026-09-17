import { page } from './shell.js';

const BODY = String.raw`<main><h1>Service visit</h1><div id="detail" class="empty">Waiting for the visit.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var detail = document.getElementById('detail');

  function textRow(parent, className, value) {
    var node = document.createElement('div');
    node.className = className;
    node.textContent = value;
    parent.appendChild(node);
  }

  function render(result) {
    var data = (result && result.structuredContent) || {};
    // book_service returns a flat booking; get_visit nests it under visit.
    var visit = data.visit || data;
    if (!visit || (!visit.provider && !visit.providerName)) {
      detail.className = 'empty';
      detail.textContent = 'No visit selected.';
      window.homeledger.reportSize();
      return;
    }
    detail.className = '';
    detail.textContent = '';

    var card = document.createElement('div');
    card.className = 'card';
    var row = document.createElement('div');
    row.className = 'row';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = visit.providerName || visit.provider;
    var status = document.createElement('span');
    status.className = visit.status === 'missed' ? 'pill warn' : 'pill';
    status.textContent = visit.status;
    row.appendChild(name);
    row.appendChild(status);
    card.appendChild(row);
    textRow(card, 'muted', visit.windowStart + ' to ' + visit.windowEnd);
    if (visit.applianceName) textRow(card, 'muted', visit.applianceName);
    if (visit.issue) textRow(card, 'muted', visit.issue);
    if (visit.arrivedAt) textRow(card, 'muted', 'arrived ' + visit.arrivedAt);
    detail.appendChild(card);

    if (data.description) {
      var described = document.createElement('div');
      described.className = 'card';
      textRow(described, 'muted', data.description);
      detail.appendChild(described);
    }
    if (data.snapshotUrl) {
      var shot = document.createElement('img');
      shot.src = data.snapshotUrl;
      shot.alt = 'Doorbell snapshot taken when the visit was matched';
      shot.style.maxWidth = '100%';
      shot.style.borderRadius = '12px';
      detail.appendChild(shot);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-visit');
})();
`;

export const VISIT_WIDGET_HTML = page('Service visit', BODY, SCRIPT);
