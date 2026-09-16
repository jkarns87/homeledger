import { page } from './shell.js';

const BODY = String.raw`<main><h1>Maintenance due</h1><div id="list" class="empty">Waiting for the schedule.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var list = document.getElementById('list');
  // Buttons currently awaiting a reply to their in-flight tool call below. A
  // host-cancelled call (ui/notifications/tool-cancelled) never settles that
  // call's own promise, so without this the button would stay disabled on
  // "Logging" forever; resetPending() below clears it independently.
  var pendingButtons = [];

  function settle(button) {
    var index = pendingButtons.indexOf(button);
    if (index !== -1) pendingButtons.splice(index, 1);
  }

  function resetPending() {
    for (var i = 0; i < pendingButtons.length; i++) {
      pendingButtons[i].disabled = false;
      pendingButtons[i].textContent = 'Retry';
    }
    pendingButtons = [];
  }

  function markDone(item, button) {
    button.disabled = true;
    button.textContent = 'Logging';
    pendingButtons.push(button);
    window.homeledger
      .callTool('log_maintenance', { applianceId: item.applianceId, taskType: item.taskType })
      .then(function (result) {
        settle(button);
        var data = (result && result.structuredContent) || {};
        button.textContent = data.nextDueAt ? 'Next ' + data.nextDueAt : 'Logged';
      })
      .catch(function (error) {
        settle(button);
        button.disabled = false;
        button.textContent = 'Retry';
        console.error('log_maintenance failed', error);
      });
  }

  function render(result) {
    // A fresh render replaces the list, so any buttons still tracked from a
    // previous render no longer exist in the DOM.
    pendingButtons = [];
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
  window.homeledger.on('toolcancelled', resetPending);
  window.homeledger.connect('homeledger-calendar');
})();
`;

export const CALENDAR_WIDGET_HTML = page('Maintenance due', BODY, SCRIPT);
