import { page } from './shell.js';

const BODY = String.raw`<main><h1 id="title">Appliance</h1><div id="detail" class="empty">Waiting for the appliance.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var title = document.getElementById('title');
  var detail = document.getElementById('detail');

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var appliance = data.appliance;
    if (!appliance) {
      detail.className = 'empty';
      detail.textContent = 'No appliance selected.';
      window.homeledger.reportSize();
      return;
    }
    title.textContent = appliance.name;
    detail.className = '';
    detail.textContent = '';

    var head = document.createElement('div');
    head.className = 'card';
    var line = document.createElement('div');
    line.className = 'muted';
    line.textContent = appliance.brand + ' ' + appliance.model + ' - ' + appliance.room;
    var warranty = document.createElement('div');
    warranty.className = appliance.warrantyStatus === 'expired' ? 'warn' : 'muted';
    warranty.textContent =
      appliance.warrantyStatus === 'active'
        ? 'Under warranty until ' + (appliance.warrantyUntil || 'an unknown date')
        : appliance.warrantyStatus === 'expired'
          ? 'Out of warranty since ' + (appliance.warrantyUntil || 'an unknown date')
          : 'Warranty unknown';
    head.appendChild(line);
    head.appendChild(warranty);
    detail.appendChild(head);

    // The title only, and only when a manual is on file. docId is an internal
    // key with nothing to link to from here (the widget has no presigned URL
    // for the PDF, the way get_visit will have one for its snapshot), so it
    // would be noise on a 768x480 canvas; the title is the one part a person
    // can act on, and showing it is what makes the ingested DOC# row visible
    // in the running system at all. Read unconditionally - get_appliance
    // always emits the key, null when there is no manual.
    var manual = data.manual;
    if (manual) {
      var manualCard = document.createElement('div');
      manualCard.className = 'card';
      var manualLine = document.createElement('div');
      manualLine.className = 'muted';
      manualLine.textContent = 'Manual on file: ' + manual.title;
      manualCard.appendChild(manualLine);
      detail.appendChild(manualCard);
    }

    var tasks = data.maintenance || [];
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      var card = document.createElement('div');
      card.className = 'card';
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = task.taskType.split('_').join(' ');
      var due = document.createElement('span');
      due.className = task.overdue ? 'warn' : 'muted';
      due.textContent = (task.overdue ? 'overdue since ' : 'due ') + task.nextDueAt;
      row.appendChild(name);
      row.appendChild(due);
      var last = document.createElement('div');
      last.className = 'muted';
      last.textContent = task.lastDoneAt ? 'last done ' + task.lastDoneAt : 'never logged';
      card.appendChild(row);
      card.appendChild(last);
      detail.appendChild(card);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-appliance');
})();
`;

export const APPLIANCE_WIDGET_HTML = page('Appliance', BODY, SCRIPT);
