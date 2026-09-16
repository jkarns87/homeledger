import { page } from './shell.js';

const BODY = String.raw`<main><h1>Maintenance due</h1><div id="list" class="empty">Waiting for the schedule.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var list = document.getElementById('list');

  function markDone(item, button) {
    button.disabled = true;
    button.textContent = 'Logging';
    window.homeledger
      .callTool('log_maintenance', { applianceId: item.applianceId, taskType: item.taskType })
      .then(function (result) {
        var data = (result && result.structuredContent) || {};
        button.textContent = data.nextDueAt ? 'Next ' + data.nextDueAt : 'Logged';
      })
      .catch(function (error) {
        button.disabled = false;
        button.textContent = 'Retry';
        console.error('log_maintenance failed', error);
      });
  }

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var items = data.items || [];
    if (items.length === 0) {
      list.className = 'empty';
      list.textContent = 'Nothing due in this window.';
      window.homeledger.reportSize();
      return;
    }
    list.className = '';
    list.textContent = '';
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var card = document.createElement('div');
        card.className = 'card';
        var row = document.createElement('div');
        row.className = 'row';
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.applianceName + ' - ' + item.taskType.split('_').join(' ');
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Log as done';
        button.addEventListener('click', function () {
          markDone(item, button);
        });
        row.appendChild(name);
        row.appendChild(button);
        var due = document.createElement('div');
        due.className = item.overdue ? 'warn' : 'muted';
        due.textContent = (item.overdue ? 'overdue since ' : 'due ') + item.nextDueAt;
        card.appendChild(row);
        card.appendChild(due);
        list.appendChild(card);
      })(items[i]);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-calendar');
})();
`;

export const CALENDAR_WIDGET_HTML = page('Maintenance due', BODY, SCRIPT);
