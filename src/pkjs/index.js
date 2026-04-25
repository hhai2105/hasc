var STORAGE_KEY = 'ha_settings_v1';
var MAX_ITEMS = 32;
var REFRESH_STATES_DEBOUNCE_MS = 2000;
var SELECTABLE_DOMAINS = {
  automation: true,
  button: true,
  cover: true,
  fan: true,
  group: true,
  humidifier: true,
  input_boolean: true,
  input_button: true,
  light: true,
  media_player: true,
  remote: true,
  scene: true,
  script: true,
  switch: true
};
var settings = loadSettings();
var latestItems = [];
var configStates = [];
var queue = [];
var sending = false;
var backgroundRefreshTimer = null;
var refreshStatesInFlight = false;
var refreshStatesQueued = false;
var refreshStatesActiveKey = '';
var refreshStatesLastKey = '';
var refreshStatesLastAt = 0;
function defaultSettings() {
  return { baseUrl: '', password: '', items: [] };
}

function loadSettings() {
  try {
    return migrateSettings(JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultSettings());
  } catch (e) {
    return defaultSettings();
  }
}

function saveSettings(nextSettings) {
  settings = migrateSettings(nextSettings || defaultSettings());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function migrateSettings(raw) {
  var next = {
    baseUrl: raw && raw.baseUrl ? raw.baseUrl : '',
    password: raw && raw.password ? raw.password : '',
    items: []
  };

  if (raw && raw.items && raw.items.length) {
    next.items = raw.items.map(normalizeItem).filter(function(item) {
      return item.singleEntity || item.longEntity;
    });
  } else if (raw && raw.entities && raw.entities.length) {
    next.items = raw.entities.map(function(entity, index) {
      var entityId = typeof entity === 'string' ? entity : entity.entity_id;
      return normalizeItem({
        id: 'legacy-' + index + '-' + entityId,
        name: entity.name || entityNameFromId(entityId),
        singleEntity: entityId,
        longEntity: '',
        statusSource: 'single'
      }, index);
    }).filter(function(item) {
      return !!item.singleEntity;
    });
  }

  next.items = next.items.slice(0, MAX_ITEMS);
  return next;
}

function normalizeItem(item, index) {
  var singleEntity = item.singleEntity || item.entity_id || item.entity || '';
  var longEntity = item.longEntity || '';
  return {
    id: item.id || ('item-' + index + '-' + singleEntity + '-' + longEntity),
    name: item.name || entityNameFromId(singleEntity || longEntity) || 'Item',
    singleEntity: singleEntity,
    longEntity: longEntity,
    statusSource: item.statusSource === 'long' ? 'long' : 'single'
  };
}

function normalizeBaseUrl(url) {
  return (url || '').replace(/\/+$/, '');
}

function normalizeToken(token) {
  return (token || '').replace(/^\s*Bearer\s+/i, '').trim();
}

function entityDomain(entityId) {
  return (entityId || '').split('.')[0];
}

function isAutomationEntity(entityId) {
  return entityDomain(entityId) === 'automation';
}

function entityNameFromId(entityId) {
  if (!entityId) {
    return '';
  }
  return entityId.replace(/^[^.]+\./, '').replace(/_/g, ' ');
}

function friendlyName(state) {
  if (state.attributes && state.attributes.friendly_name) {
    return state.attributes.friendly_name;
  }
  return entityNameFromId(state.entity_id);
}

function displayState(state) {
  if (!state) {
    return '';
  }

  var value = String(state).toLowerCase();
  if (value === 'on') {
    return 'ON';
  }
  if (value === 'off') {
    return 'OFF';
  }
  return String(state).toUpperCase().substr(0, 15);
}

function automationIsRunning(state) {
  if (!state || !state.attributes) {
    return false;
  }

  return Number(state.attributes.current || 0) > 0;
}

function isSelectableEntity(state) {
  var domain = entityDomain(state.entity_id);
  return !!SELECTABLE_DOMAINS[domain];
}

function request(method, path, body, callback) {
  var baseUrl = normalizeBaseUrl(settings.baseUrl);
  var token = normalizeToken(settings.password);
  if (!baseUrl || !token) {
    callback(new Error('Configure app'));
    return;
  }

  console.log('HA request ' + method + ' ' + baseUrl + path);
  var xhr = new XMLHttpRequest();
  xhr.open(method, baseUrl + path, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) {
      return;
    }

    console.log('HA response ' + xhr.status + ' for ' + method + ' ' + path);
    if (xhr.status < 200 || xhr.status >= 300) {
      callback(new Error('HA HTTP ' + xhr.status));
      return;
    }

    var response = null;
    if (xhr.responseText) {
      try {
        response = JSON.parse(xhr.responseText);
      } catch (e) {
        callback(new Error('Bad HA response'));
        return;
      }
    }
    callback(null, response);
  };
  xhr.onerror = function() {
    console.log('HA onerror for ' + method + ' ' + baseUrl + path);
    callback(new Error('HA onerror; check phone logs'));
  };
  xhr.send(body ? JSON.stringify(body) : null);
}

function sendNow(message, success, failure) {
  Pebble.sendAppMessage(message, success, failure);
}

function sendMessage(message) {
  queue.push(message);
  pumpQueue();
}

function pumpQueue() {
  if (sending || queue.length === 0) {
    return;
  }

  sending = true;
  sendNow(queue.shift(), function() {
    sending = false;
    pumpQueue();
  }, function() {
    sending = false;
    if (queue.length > 0) {
      pumpQueue();
    }
  });
}

function sendStatus(status) {
  sendMessage({ Status: status });
}

function sendError(error) {
  sendMessage({ Error: error.message || String(error) });
}

function sendSettingsNeeded(status) {
  latestItems = [];
  sendMessage({ ItemCount: 0, SettingsNeeded: 1, Status: status });
}

function statusEntityForItem(item) {
  if (item.statusSource === 'long' && item.longEntity) {
    return item.longEntity;
  }
  return item.singleEntity || item.longEntity || '';
}

function sendItem(index, item, stateRecord, hasState) {
  var safeItem = normalizeItem(item, index);
  var statusEntity = statusEntityForItem(safeItem);
  var state = hasState && stateRecord ? stateRecord.state : '';
  var statePending = isAutomationEntity(statusEntity) ? automationIsRunning(stateRecord) : !hasState;
  var shownState = isAutomationEntity(statusEntity) ? '' : displayState(state);
  latestItems[index] = {
    id: safeItem.id,
    name: safeItem.name,
    singleEntity: safeItem.singleEntity,
    longEntity: safeItem.longEntity,
    statusSource: safeItem.statusSource,
    state: state || ''
  };
  sendMessage({
    Index: index,
    Entity: safeItem.singleEntity || safeItem.longEntity,
    Name: safeItem.name.substr(0, 31),
    State: shownState,
    StatePending: statePending ? 1 : 0
  });
}

function sendItems(items, statesById, options) {
  var normalized = (items || []).map(normalizeItem).slice(0, MAX_ITEMS);
  var hasRunningAutomation = false;

  if (!options || options.sendCount !== false) {
    latestItems = [];
    sendMessage({ ItemCount: normalized.length });
  }

  normalized.forEach(function(item, index) {
    var stateEntity = statusEntityForItem(item);
    var stateRecord = statesById && statesById[stateEntity] ? statesById[stateEntity] : null;
    if (isAutomationEntity(stateEntity) && automationIsRunning(stateRecord)) {
      hasRunningAutomation = true;
    }
    sendItem(index, item, stateRecord, !!stateRecord);
  });

  if (hasRunningAutomation) {
    scheduleBackgroundStatusRefresh();
  }
}

function scheduleBackgroundStatusRefresh() {
  if (backgroundRefreshTimer) {
    return;
  }

  backgroundRefreshTimer = setTimeout(function() {
    backgroundRefreshTimer = null;
    refreshItemStatusesInBackground();
  }, 1000);
}

function refreshItemStatusesInBackground() {
  request('GET', '/api/states', null, function(error, states) {
    if (error) {
      refreshStates();
      return;
    }

    var byId = {};
    states.forEach(function(state) {
      byId[state.entity_id] = state;
    });

    sendItems(settings.items, byId, { sendCount: false });
    sendStatus('Ready');
  });
}

function refreshStatesKey() {
  return normalizeBaseUrl(settings.baseUrl) + '|' + normalizeToken(settings.password) + '|' + JSON.stringify(settings.items || []);
}

function finishRefreshStates(success) {
  if (success) {
    refreshStatesLastKey = refreshStatesActiveKey;
    refreshStatesLastAt = new Date().getTime();
  }
  refreshStatesInFlight = false;
  refreshStatesActiveKey = '';
  if (refreshStatesQueued) {
    refreshStatesQueued = false;
    refreshStates();
  }
}

function refreshStates() {
  if (!settings.baseUrl || !settings.password) {
    sendSettingsNeeded('Open HASC settings in Pebble app');
    return;
  }

  if (!settings.items || settings.items.length === 0) {
    sendSettingsNeeded('Add items in HASC settings');
    return;
  }

  var key = refreshStatesKey();
  if (key === refreshStatesLastKey && new Date().getTime() - refreshStatesLastAt < REFRESH_STATES_DEBOUNCE_MS) {
    return;
  }

  if (refreshStatesInFlight) {
    if (key !== refreshStatesActiveKey) {
      refreshStatesQueued = true;
    }
    return;
  }

  refreshStatesInFlight = true;
  refreshStatesActiveKey = key;
  sendItems(settings.items);
  sendStatus('Loading statuses');
  request('GET', '/api/states', null, function(error, states) {
    if (error) {
      sendError(error);
      finishRefreshStates(false);
      return;
    }

    var byId = {};
    states.forEach(function(state) {
      byId[state.entity_id] = state;
    });

    sendItems(settings.items, byId);
    sendStatus('Ready');
    finishRefreshStates(true);
  });
}

function serviceForEntity(entityId) {
  var domain = entityDomain(entityId);
  if (domain === 'automation') {
    return { path: '/api/services/automation/trigger', body: { entity_id: entityId } };
  }
  if (domain === 'button') {
    return { path: '/api/services/button/press', body: { entity_id: entityId } };
  }
  if (domain === 'input_button') {
    return { path: '/api/services/input_button/press', body: { entity_id: entityId } };
  }
  if (domain === 'scene') {
    return { path: '/api/services/scene/turn_on', body: { entity_id: entityId } };
  }
  if (domain === 'script') {
    return { path: '/api/services/script/turn_on', body: { entity_id: entityId } };
  }
  return { path: '/api/services/homeassistant/toggle', body: { entity_id: entityId } };
}

function triggerItem(index, pressType) {
  var item = latestItems[index] || settings.items[index];
  if (!item) {
    sendError(new Error('Unknown item'));
    return;
  }

  var target = pressType === 'long' ? item.longEntity : item.singleEntity;
  if (!target) {
    sendError(new Error(pressType === 'long' ? 'No long press action' : 'No press action'));
    return;
  }

  var service = serviceForEntity(target);
  request('POST', service.path, service.body, function(error) {
    if (error) {
      sendError(error);
      return;
    }

    if (isAutomationEntity(target)) {
      refreshItemStatusesInBackground();
      return;
    }

    var statusEntity = statusEntityForItem(item);
    if (!statusEntity) {
      sendItem(index, item, null, true);
      sendStatus('Ready');
      return;
    }

    request('GET', '/api/states/' + encodeURIComponent(statusEntity), null, function(stateError, state) {
      if (stateError) {
        refreshStates();
        return;
      }

      sendItem(index, item, state, true);
      sendStatus('Ready');
    });
  });
}

function openConfig(states, status) {
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(configHtml(states, status)));
}

function configHtml(states, status) {
  var initial = JSON.stringify(settings).replace(/</g, '\\u003c');
  var available = JSON.stringify(states || []).replace(/</g, '\\u003c');
  var message = JSON.stringify(status || '').replace(/</g, '\\u003c');
  var storageKey = JSON.stringify(STORAGE_KEY).replace(/</g, '\\u003c');
  var domains = JSON.stringify(SELECTABLE_DOMAINS).replace(/</g, '\\u003c');
  var css = [
    '*{box-sizing:border-box}body{margin:0;font:17px/1.4 PFDinDisplayProRegularWebfont,PFDinDisplayPro-Regular,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased;background:#333;color:#fff}',
    'main{min-height:100vh;max-width:780px;margin:0 auto;padding:14px 14px 92px}h1,h2{font-family:PFDinDisplayPro-Medium,PFDinDisplayProRegularWebfont,sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.025em;line-height:.95;margin:0 0 4px}h1{font-size:28px}h2{font-size:20px}p{color:#a4a4a4;margin:6px 0 16px;line-height:1.4}.hidden{display:none!important}strong{color:#ff4700}',
    '.panel{background:#484848;border-radius:.25rem;padding:16px;box-shadow:#2f2f2f 0 .15rem .25rem;margin:12px 0}.loader{position:fixed;inset:0;z-index:50;background:#333;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center}.spin{width:42px;height:42px;margin:0 auto 16px;border:4px solid #5b5b5b;border-top-color:#ff4700;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}',
    '.appbar{position:sticky;top:0;z-index:10;margin:-14px -14px 12px;padding:12px 14px;background:rgba(51,51,51,.96);backdrop-filter:blur(14px);border-bottom:1px solid #484848}.setupOnly .appbar,.setupOnly #devicesPane,.setupOnly #refreshPanel,.setupOnly #clearPanel{display:none!important}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:#414141;border:1px solid #666;border-radius:.25rem}.tab{margin:0;border:0;border-radius:.25rem;padding:10px;background:transparent;color:#ececec;font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.025em}.tab.active{background:#ff4700;color:#fff}.barrow{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:10px}',
    'label{display:block;margin:14px 0 6px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.025em}input{width:100%;padding:10px;border:0;border-radius:.25rem;background:#333;color:#fff;font:inherit;appearance:none}input::placeholder{color:#858585}button{border:0;border-radius:.25rem;padding:10px 14px;margin:0;background:#ff4700;color:#fff;font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.025em}button:active{background:#ff0000}button.secondary{background:#767676;color:#fff}button.secondary:active{background:#858585}button.danger{background:#993d19;color:#fff}button.danger:active{background:#ff0000}button.ghost{background:transparent;color:#ececec;border:1px solid #767676}.saveTop{background:#767676;color:#fff}.serverAction{margin-top:18px}',
    '.status{min-height:22px;margin:12px 0;color:#ff4700}.status:empty{display:none}.error{color:#ff0000}.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sectionTitle{display:flex;align-items:center;justify-content:space-between;gap:10px}.item{padding:14px;margin:10px 0;background:#484848;border-radius:.25rem;box-shadow:#2f2f2f 0 .15rem .25rem}.name{font-weight:700;text-transform:uppercase;letter-spacing:.025em}.entity{font-size:13px;color:#a4a4a4;margin-top:3px;overflow:hidden;text-overflow:ellipsis}',
    '.itemActions{display:flex;gap:8px;align-items:center;margin-top:10px}.editBtn{flex:1}.moveBtn{width:52px;padding-left:0;padding-right:0}.fab{position:fixed;right:18px;bottom:18px;z-index:20;width:58px;height:58px;border-radius:50%;padding:0;font-size:32px;line-height:58px;box-shadow:#2f2f2f 0 .15rem .25rem}',
    '.fieldBtn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;background:#333;color:#fff;border:0}.fieldSub{display:block;color:#a4a4a4;font-size:13px;font-weight:400;margin-top:3px;overflow:hidden;text-overflow:ellipsis}.editHead{display:flex;align-items:start;justify-content:space-between;gap:12px}.editBottom{position:sticky;bottom:0;margin:18px -16px -16px;padding:12px 16px;background:#414141;border-top:1px solid #666;display:flex;gap:10px}.editBottom button{flex:1}',
    '.modal{position:fixed;inset:0;z-index:60;background:#333;display:flex;flex-direction:column}.modalHead{padding:14px;border-bottom:1px solid #666;background:#414141}.modalTools{padding:12px 14px;border-bottom:1px solid #666}.chips{display:flex;gap:8px;overflow:auto;padding-top:10px}.chip{white-space:nowrap;padding:8px 10px;border-radius:.25rem;background:#767676;color:#fff;border:0;font-size:13px}.chip.active{background:#ff4700;color:#fff}.entityList{overflow:auto;padding:8px 14px 20px}.entityChoice{width:100%;display:block;text-align:left;margin:8px 0;padding:13px;border-radius:.25rem;background:#484848;color:#fff;border:0;box-shadow:#2f2f2f 0 .15rem .25rem}.entityChoice strong{display:block}.entityChoice span{display:block;color:#a4a4a4;font-size:13px;margin-top:3px}',
    '@media(max-width:520px){main{padding-left:12px;padding-right:12px}.row{grid-template-columns:1fr}.barrow{align-items:flex-start}.saveTop{padding:9px 12px}}'
  ].join('');
  var script = 'var settings=' + initial + ';var states=' + available + ';var statusMessage=' + message + ';var storageKey=' + storageKey + ';var domains=' + domains + ';(' + configScript.toString() + ')();';

  return [
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>HASC</title><style>', css, '</style></head><body><main>',
    '<section id="loader" class="loader hidden"><div><div class="spin"></div><h1>Loading devices</h1><p id="loaderStatus">Connecting to Home Assistant...</p></div></section>',
    '<section id="app" class="hidden"><div class="appbar"><div class="barrow"><h1>HASC</h1><button id="save" type="button" class="saveTop">Save</button></div><div class="tabs"><button id="tabDevices" type="button" class="tab">Devices</button><button id="tabSettings" type="button" class="tab">Settings</button></div></div>',
    '<section id="devicesPane"><div id="itemsStatus" class="status"></div><div id="itemList"></div><button id="add" type="button" class="fab" aria-label="Add item">+</button></section>',
    '<section id="settingsPane" class="hidden"><div class="panel"><h2>Server Configuration</h2><p>Set the Base URL of your Home Assistant server and enter an Access token (Account Settings &gt; Security &gt; Long-lived access tokens). Access token is stored locally on your phone.</p><label for="baseUrl">Base URL</label><input id="baseUrl" type="text" placeholder="https://home.example.com"><label for="password">Access token</label><input id="password" type="password" autocomplete="off"><button id="continue" type="button" class="serverAction">Continue</button><div id="setupStatus" class="status"></div></div><div id="refreshPanel" class="panel"><h2>Refresh Devices</h2><p>Refresh the list of available devices from Home Assistant.</p><button id="refresh" type="button" class="secondary">Refresh devices</button><div id="refreshStatus" class="status"></div></div><div id="clearPanel" class="panel"><h2>Clear Data</h2><p>This deletes your configuration. This cannot be undone.</p><button id="clearData" type="button" class="danger">Clear data</button><div id="clearStatus" class="status"></div></div></section></section>',
    '<section id="edit" class="panel hidden"><div class="editHead"><div><h1 id="editTitle">Edit Item</h1><p>Choose the actions and display details for this watch row.</p></div><button id="deleteItem" type="button" class="danger">Delete</button></div><label for="itemName">Watch name</label><input id="itemName" type="text" maxlength="31">',
    '<input id="singleEntity" type="hidden"><input id="longEntity" type="hidden"><label>One-press action</label><button id="singleEntityPick" type="button" class="fieldBtn"></button><label>Long-press action</label><button id="longEntityPick" type="button" class="fieldBtn"></button><label>Status shown on watch</label><div class="tabs"><button id="statusSingle" type="button" class="tab">One-press</button><button id="statusLong" type="button" class="tab">Long-press</button></div><input id="statusSource" type="hidden"><div id="editStatus" class="status"></div><div class="editBottom"><button id="cancelEdit" type="button" class="secondary">Cancel</button><button id="saveItem" type="button">Save item</button></div></section>',
    '<section id="picker" class="modal hidden"><div class="modalHead"><div class="barrow"><div><h1 id="pickerTitle">Choose Entity</h1><p id="pickerHint">Search by name or entity id.</p></div><button id="closePicker" type="button" class="secondary">Close</button></div></div><div class="modalTools"><input id="entitySearch" type="text" placeholder="Search entities"><div id="domainChips" class="chips"></div></div><div id="entityList" class="entityList"></div></section>',
    '<script>', script, '</script></main></body></html>'
  ].join('');
}

function configScript() {
  var editingIndex = -1;
  var activePicker = '';
  var activeDomain = 'all';
  var isOnboarding = false;
  var clearArmed = false;

  function $(id) {
    return document.getElementById(id);
  }

  function show(id) {
    ['app', 'edit', 'loader'].forEach(function(screen) {
      $(screen).className = screen === id ? $(screen).className.replace(/\s*hidden/g, '') : addClass($(screen).className, 'hidden');
    });
    if (id !== 'edit') {
      $('picker').className = addClass($('picker').className, 'hidden');
    }
  }

  function addClass(value, name) {
    return value.indexOf(name) >= 0 ? value : value + ' ' + name;
  }

  function removeClass(value, name) {
    return value.replace(new RegExp('\\s*' + name, 'g'), '');
  }

  function setSetupOnly(enabled) {
    $('app').className = enabled ? addClass($('app').className, 'setupOnly') : removeClass($('app').className, 'setupOnly');
  }

  function setStatus(id, text, isError) {
    if (id === 'loaderStatus') {
      $(id).textContent = text || '';
      return;
    }
    $(id).textContent = text || '';
    $(id).className = isError ? 'status error' : 'status';
  }

  function esc(value) {
    return String(value || '').replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function normalizeSettings() {
    settings.baseUrl = settings.baseUrl || '';
    settings.password = settings.password || '';
    settings.items = (settings.items || []).map(function(item, index) {
      var singleEntity = item.singleEntity || item.entity_id || item.entity || '';
      var longEntity = item.longEntity || '';
      return {
        id: item.id || ('item-' + index + '-' + singleEntity + '-' + longEntity),
        name: item.name || nameForEntity(singleEntity || longEntity) || 'Item',
        singleEntity: singleEntity,
        longEntity: longEntity,
        statusSource: item.statusSource === 'long' ? 'long' : 'single'
      };
    });
  }

  function currentSettings() {
    normalizeSettings();
    return {
      baseUrl: settings.baseUrl || '',
      password: settings.password || '',
      items: settings.items || []
    };
  }

  function persistSettings(statusId) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(currentSettings()));
    } catch (e) {
      // Some Pebble config webviews open data: URLs without localStorage.
      // The parent app still receives the current settings on Done and saves them.
    }
    return true;
  }

  function entityDomain(entityId) {
    return (entityId || '').split('.')[0];
  }

  function fallbackName(entityId) {
    return entityId ? entityId.replace(/^[^.]+\./, '').replace(/_/g, ' ') : '';
  }

  function stateName(state) {
    return state && state.attributes && state.attributes.friendly_name ? state.attributes.friendly_name : fallbackName(state.entity_id);
  }

  function nameForEntity(entityId) {
    var state = findState(entityId);
    return state ? stateName(state) : fallbackName(entityId);
  }

  function findState(entityId) {
    for (var i = 0; i < states.length; i++) {
      if (states[i].entity_id === entityId) {
        return states[i];
      }
    }
    return null;
  }

  function token() {
    return $('password').value.replace(/^\s*Bearer\s+/i, '').replace(/^\s+|\s+$/g, '');
  }

  function cleanBaseUrl() {
    return $('baseUrl').value.replace(/\/+$/, '').replace(/^\s+|\s+$/g, '');
  }

  function wsUrl(baseUrl) {
    var u = baseUrl.replace(/\/+$/, '');
    if (u.indexOf('https://') === 0) {
      return 'wss://' + u.substr(8) + '/api/websocket';
    }
    if (u.indexOf('http://') === 0) {
      return 'ws://' + u.substr(7) + '/api/websocket';
    }
    return '';
  }

  function loadStates(onSuccess, statusId, onFailure) {
    var baseUrl = cleanBaseUrl();
    var access = token();
    var url = wsUrl(baseUrl);
    var done = false;
    var ws;
    var timer;

    function progress(message) {
      setStatus(statusId, statusId === 'refreshStatus' ? 'Loading...' : message, false);
    }

    function fail(message) {
      setStatus(statusId, statusId === 'refreshStatus' ? 'Refresh Failed' : message, true);
      if (onFailure) {
        onFailure(message);
      }
    }

    if (!url || !access) {
      fail('Enter a valid http(s) URL and token first.');
      return;
    }

    progress('Connecting to Home Assistant...');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      fail('Could not open Home Assistant WebSocket.');
      return;
    }

    timer = setTimeout(function() {
      if (!done) {
        done = true;
        try { ws.close(); } catch (e) {}
        fail('Timed out reaching Home Assistant.');
      }
    }, 15000);

    ws.onmessage = function(ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: access }));
        return;
      }
      if (msg.type === 'auth_invalid') {
        done = true;
        clearTimeout(timer);
        fail('Home Assistant auth failed. Fix the token to continue.');
        try { ws.close(); } catch (e) {}
        return;
      }
      if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ id: 1, type: 'get_states' }));
        return;
      }
      if (msg.id === 1 && msg.type === 'result') {
        done = true;
        clearTimeout(timer);
        if (!msg.success) {
          fail('Could not load Home Assistant states.');
          return;
        }
        settings.baseUrl = baseUrl;
        settings.password = access;
        states = (msg.result || []).filter(function(s) {
          return domains[s.entity_id.split('.')[0]];
        }).sort(function(a, b) {
          return stateName(a).localeCompare(stateName(b));
        });
        if (!persistSettings(statusId)) {
          try { ws.close(); } catch (e) {}
          return;
        }
        setStatus(statusId, statusId === 'refreshStatus' ? states.length + ' Devices Found' : states.length + ' devices/groups loaded.');
        try { ws.close(); } catch (e) {}
        onSuccess();
      }
    };
    ws.onerror = function() {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fail('Home Assistant WebSocket failed. Check the URL.');
      }
    };
    ws.onclose = function() {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fail('Connection closed before devices loaded.');
      }
    };
  }

  function setTab(name) {
    var devices = name === 'devices';
    $('devicesPane').className = devices ? '' : 'hidden';
    $('settingsPane').className = devices ? 'hidden' : '';
    $('tabDevices').className = devices ? 'tab active' : 'tab';
    $('tabSettings').className = devices ? 'tab' : 'tab active';
    $('add').className = devices ? 'fab' : 'fab hidden';
    $('continue').textContent = isOnboarding ? 'Continue' : 'Save';
  }

  function entitySummary(item) {
    var single = item.singleEntity ? 'Tap: ' + item.singleEntity : 'Tap: not set';
    var longPress = item.longEntity ? 'Long: ' + item.longEntity : 'Long: not set';
    return single + ' | ' + longPress;
  }

  function renderItems() {
    var html = '';
    if (settings.items.length === 0) {
      html = '<div class="panel"><h2>Create an Item to Begin</h2><p>Add an item using the + button in the bottom-right corner, choose its Home Assistant actions, then save the item.</p></div>';
    } else {
      settings.items.forEach(function(item, index) {
        html += '<div class="item"><div class="name">' + esc(item.name) + '</div><div class="entity">' + esc(entitySummary(item)) + '</div><div class="itemActions"><button type="button" class="editBtn" data-action="edit" data-index="' + index + '">Edit</button><button type="button" class="secondary moveBtn" data-action="up" data-index="' + index + '">Up</button><button type="button" class="secondary moveBtn" data-action="down" data-index="' + index + '">Down</button></div></div>';
      });
    }
    $('itemList').innerHTML = html;
    setStatus('itemsStatus', statusMessage || (states.length ? '' : 'Refresh devices before adding new actions.'));
  }

  function fieldLabel(entityId, allowNone) {
    if (!entityId) {
      return allowNone ? '<strong>None</strong><span class="fieldSub">No action assigned</span>' : '<strong>Choose entity</strong><span class="fieldSub">Search devices/groups</span>';
    }
    return '<strong>' + esc(nameForEntity(entityId) || entityId) + '</strong><span class="fieldSub">' + esc(entityId) + '</span>';
  }

  function updateEntityFields() {
    $('singleEntityPick').innerHTML = '<span>' + fieldLabel($('singleEntity').value, false) + '</span><span>Choose</span>';
    $('longEntityPick').innerHTML = '<span>' + fieldLabel($('longEntity').value, true) + '</span><span>Choose</span>';
  }

  function domainsInStates() {
    var seen = { all: true };
    var list = ['all'];
    states.forEach(function(state) {
      var domain = entityDomain(state.entity_id);
      if (!seen[domain]) {
        seen[domain] = true;
        list.push(domain);
      }
    });
    return list;
  }

  function renderDomainChips() {
    $('domainChips').innerHTML = domainsInStates().map(function(domain) {
      return '<button type="button" class="chip' + (domain === activeDomain ? ' active' : '') + '" data-domain="' + esc(domain) + '">' + esc(domain === 'all' ? 'All' : domain) + '</button>';
    }).join('');
  }

  function renderEntityList() {
    var query = $('entitySearch').value.replace(/^\s+|\s+$/g, '').toLowerCase();
    var includeNone = activePicker === 'longEntity';
    var html = includeNone && (!query || 'none'.indexOf(query) >= 0) ? '<button type="button" class="entityChoice" data-entity=""><strong>None</strong><span>No long-press action</span></button>' : '';
    var count = 0;
    states.forEach(function(state) {
      var domain = entityDomain(state.entity_id);
      var name = stateName(state);
      var haystack = (name + ' ' + state.entity_id).toLowerCase();
      if (activeDomain !== 'all' && domain !== activeDomain) {
        return;
      }
      if (query && haystack.indexOf(query) < 0) {
        return;
      }
      count++;
      html += '<button type="button" class="entityChoice" data-entity="' + esc(state.entity_id) + '"><strong>' + esc(name) + '</strong><span>' + esc(state.entity_id) + '</span></button>';
    });
    $('entityList').innerHTML = html || '<p>No matching entities.</p>';
    $('pickerHint').textContent = count + ' matching entities';
  }

  function openPicker(field) {
    activePicker = field;
    activeDomain = 'all';
    $('pickerTitle').textContent = field === 'singleEntity' ? 'One-press Action' : 'Long-press Action';
    $('entitySearch').value = '';
    renderDomainChips();
    renderEntityList();
    $('picker').className = $('picker').className.replace(/\s*hidden/g, '');
    setTimeout(function() { $('entitySearch').focus(); }, 0);
  }

  function updateStatusTabs() {
    var longActive = $('statusSource').value === 'long';
    $('statusSingle').className = longActive ? 'tab' : 'tab active';
    $('statusLong').className = longActive ? 'tab active' : 'tab';
  }

  function openEditor(index) {
    editingIndex = index;
    var item = index >= 0 ? settings.items[index] : {
      id: 'item-' + Date.now(),
      name: '',
      singleEntity: states.length ? states[0].entity_id : '',
      longEntity: '',
      statusSource: 'single'
    };
    $('editTitle').textContent = index >= 0 ? 'Edit Item' : 'Add Item';
    $('itemName').value = item.name || '';
    $('singleEntity').value = item.singleEntity || '';
    $('longEntity').value = item.longEntity || '';
    $('statusSource').value = item.statusSource === 'long' ? 'long' : 'single';
    updateEntityFields();
    updateStatusTabs();
    $('deleteItem').style.display = index >= 0 ? '' : 'none';
    setStatus('editStatus', states.length ? '' : 'Refresh devices to pick from loaded entities.', !states.length);
    show('edit');
  }

  function saveItem() {
    var singleEntity = $('singleEntity').value;
    var longEntity = $('longEntity').value;
    if (!singleEntity && !longEntity) {
      setStatus('editStatus', 'Choose at least one action.', true);
      return;
    }

    var name = $('itemName').value.replace(/^\s+|\s+$/g, '') || nameForEntity(singleEntity || longEntity) || 'Item';
    var item = {
      id: editingIndex >= 0 ? settings.items[editingIndex].id : 'item-' + Date.now(),
      name: name,
      singleEntity: singleEntity,
      longEntity: longEntity,
      statusSource: $('statusSource').value === 'long' ? 'long' : 'single'
    };
    if (editingIndex >= 0) {
      settings.items[editingIndex] = item;
    } else {
      settings.items.push(item);
    }
    if (!persistSettings('editStatus')) {
      return;
    }
    renderItems();
    show('app');
    setTab('devices');
  }

  function moveItem(index, direction) {
    var other = index + direction;
    if (other < 0 || other >= settings.items.length) {
      return;
    }
    var item = settings.items[index];
    settings.items[index] = settings.items[other];
    settings.items[other] = item;
    if (!persistSettings('itemsStatus')) {
      return;
    }
    renderItems();
  }

  function deleteItem() {
    if (editingIndex >= 0) {
      settings.items.splice(editingIndex, 1);
    }
    if (!persistSettings('editStatus')) {
      return;
    }
    renderItems();
    show('app');
    setTab('devices');
  }

  function closeWithDone() {
    persistSettings();
    location.href = 'pebblejs://close#' + encodeURIComponent(JSON.stringify({
      action: 'done',
      settings: currentSettings()
    }));
  }

  function clearSettings() {
    settings = { baseUrl: '', password: '', items: [] };
    states = [];
    statusMessage = 'All data cleared.';
    $('baseUrl').value = '';
    $('password').value = '';
    if (!persistSettings('clearStatus')) {
      return;
    }
    clearArmed = false;
    $('clearData').textContent = 'Clear data';
    renderItems();
    isOnboarding = true;
    setSetupOnly(true);
    show('app');
    setTab('settings');
    setStatus('setupStatus', 'All data cleared. Connect a Home Assistant server to continue.');
  }

  normalizeSettings();
  $('baseUrl').value = settings.baseUrl || '';
  $('password').value = settings.password || '';
  $('continue').onclick = function() {
    loadStates(function() {
      isOnboarding = false;
      setSetupOnly(false);
      renderItems();
      show('app');
      setTab('devices');
    }, 'setupStatus');
  };
  $('refresh').onclick = function() {
    setStatus('refreshStatus', 'Loading...');
    loadStates(function() {
      renderItems();
    }, 'refreshStatus', function() {
      setStatus('refreshStatus', 'Refresh Failed', true);
    });
  };
  $('tabDevices').onclick = function() { setTab('devices'); };
  $('tabSettings').onclick = function() { setTab('settings'); };
  $('add').onclick = function() {
    openEditor(-1);
  };
  $('save').onclick = closeWithDone;
  $('clearData').onclick = function() {
    if (!clearArmed) {
      clearArmed = true;
      $('clearData').textContent = 'Tap Again to Confirm';
      setStatus('clearStatus', 'This will permanently delete your configuration, please confirm.', true);
      return;
    }
    clearSettings();
  };
  $('saveItem').onclick = saveItem;
  $('cancelEdit').onclick = function() {
    renderItems();
    show('app');
    setTab('devices');
  };
  $('deleteItem').onclick = deleteItem;
  $('itemList').onclick = function(e) {
    var target = e.target || e.srcElement;
    var action = target.getAttribute('data-action');
    var index = parseInt(target.getAttribute('data-index'), 10);
    while (!action && target.parentNode) {
      target = target.parentNode;
      action = target.getAttribute('data-action');
      index = parseInt(target.getAttribute('data-index'), 10);
    }
    if (action === 'edit') {
      openEditor(index);
    } else if (action === 'up') {
      moveItem(index, -1);
    } else if (action === 'down') {
      moveItem(index, 1);
    }
  };
  $('singleEntityPick').onclick = function() { openPicker('singleEntity'); };
  $('longEntityPick').onclick = function() { openPicker('longEntity'); };
  $('closePicker').onclick = function() { $('picker').className = addClass($('picker').className, 'hidden'); };
  $('entitySearch').oninput = renderEntityList;
  $('domainChips').onclick = function(e) {
    var target = e.target || e.srcElement;
    var domain = target.getAttribute('data-domain');
    if (!domain) {
      return;
    }
    activeDomain = domain;
    renderDomainChips();
    renderEntityList();
  };
  $('entityList').onclick = function(e) {
    var target = e.target || e.srcElement;
    while (target && target.className !== 'entityChoice') {
      target = target.parentNode;
    }
    if (!target) {
      return;
    }
    $(activePicker).value = target.getAttribute('data-entity') || '';
    updateEntityFields();
    $('picker').className = addClass($('picker').className, 'hidden');
    if (!$('itemName').value && activePicker === 'singleEntity') {
      $('itemName').value = nameForEntity($('singleEntity').value);
    }
  };
  $('statusSingle').onclick = function() { $('statusSource').value = 'single'; updateStatusTabs(); };
  $('statusLong').onclick = function() { $('statusSource').value = 'long'; updateStatusTabs(); };

  if (!settings.baseUrl || !settings.password) {
    isOnboarding = true;
    setSetupOnly(true);
    show('app');
    setTab('settings');
    setStatus('setupStatus', statusMessage || 'Connect a Home Assistant server to continue.');
  } else {
    isOnboarding = false;
    setSetupOnly(false);
    show('loader');
    loadStates(function() {
      renderItems();
      show('app');
      setTab('devices');
    }, 'loaderStatus', function(message) {
      isOnboarding = true;
      setSetupOnly(true);
      show('app');
      setTab('settings');
      setStatus('setupStatus', message || 'Could not load devices. Check server settings.', true);
    });
  }
}

Pebble.addEventListener('ready', function() {
  refreshStates();
});

Pebble.addEventListener('showConfiguration', function() {
  openConfig(configStates, '');
});

function applyStoredSettings() {
  settings = loadSettings();
  if (!settings.baseUrl || !settings.password) {
    configStates = [];
    latestItems = [];
    sendItems([]);
    sendStatus('Open settings on phone');
    return;
  }
  refreshStates();
}

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response) {
    applyStoredSettings();
    return;
  }

  try {
    var response = JSON.parse(decodeURIComponent(e.response));
    if (response.action === 'clear') {
      saveSettings(defaultSettings());
      applyStoredSettings();
      openConfig([], 'All data cleared.');
      return;
    }
    if (response.action === 'done') {
      if (response.settings) {
        saveSettings(response.settings);
      }
      applyStoredSettings();
      return;
    }

    saveSettings({
      baseUrl: response.baseUrl,
      password: response.password,
      items: response.items || []
    });
    refreshStates();
  } catch (error) {
    sendError(new Error('Settings not saved'));
  }
});

Pebble.addEventListener('appmessage', function(e) {
  var action = e.payload.Action;
  if (action === 'single' || action === 'toggle') {
    triggerItem(e.payload.Index, 'single');
  } else if (action === 'long') {
    triggerItem(e.payload.Index, 'long');
  } else {
    refreshStates();
  }
});
