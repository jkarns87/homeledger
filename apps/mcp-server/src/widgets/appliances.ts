import { page } from './shell.js';

const BODY = String.raw`<main><h1>Appliances</h1><div id="list" class="empty">Waiting for the appliance list.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var list = document.getElementById('list');

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var rows = data.appliances || [];
    if (rows.length === 0) {
      list.className = 'empty';
      list.textContent = 'No appliances on record.';
      window.homeledger.reportSize();
      return;
    }
    list.className = '';
    list.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      var card = document.createElement('div');
      card.className = 'card';
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = a.name;
      var status = document.createElement('span');
      status.className = a.warrantyStatus === 'expired' ? 'pill warn' : 'pill';
      status.textContent = a.warrantyStatus === 'active' ? 'under warranty' : a.warrantyStatus === 'expired' ? 'out of warranty' : 'warranty unknown';
      row.appendChild(name);
      row.appendChild(status);
      var detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = a.brand + ' ' + a.model + ' - ' + a.room;
      card.appendChild(row);
      card.appendChild(detail);
      list.appendChild(card);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-appliances');
})();
`;

export const APPLIANCES_WIDGET_HTML = page('Appliances', BODY, SCRIPT);
