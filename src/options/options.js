import { createSettingsStore } from '../lib/settings-store.js';

const store = createSettingsStore(chrome.storage.local);

const form = document.getElementById('settings-form');
const input = document.getElementById('service-url');
const status = document.getElementById('service-url-status');
const configured = document.getElementById('configured-state');
const clearButton = document.getElementById('clear-service-url');

const NOT_CONFIGURED_TEXT = '未配置';
const READ_FAILED_TEXT = '读取失败';

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} message @param {'ok' | 'error' | 'none'} kind */
function setStatus(message, kind) {
  status.textContent = message;
  if (kind === 'none') {
    delete status.dataset.kind;
  } else {
    status.dataset.kind = kind;
  }
}

/** @param {string} serviceUrl */
function renderConfigured(serviceUrl) {
  configured.textContent = serviceUrl === '' ? NOT_CONFIGURED_TEXT : serviceUrl;
}

async function load() {
  try {
    const serviceUrl = await store.readServiceUrl();
    // No implicit default: an unconfigured profile renders empty and stays empty
    // until the operator saves an explicit value.
    input.value = serviceUrl;
    renderConfigured(serviceUrl);
    setStatus(
      serviceUrl === '' ? '尚未配置 Service URL。' : '已从 chrome.storage.local 读取当前配置。',
      'none',
    );
  } catch (error) {
    configured.textContent = READ_FAILED_TEXT;
    setStatus(`读取配置失败：${describeError(error)}`, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  let result;
  try {
    result = await store.saveServiceUrl(input.value);
  } catch (error) {
    setStatus(`保存失败：${describeError(error)}`, 'error');
    return;
  }
  if (!result.ok) {
    setStatus(result.error, 'error');
    return;
  }
  input.value = result.value;
  renderConfigured(result.value);
  setStatus(result.value === '' ? '已清除配置。' : '已保存。', 'ok');
});

clearButton.addEventListener('click', async () => {
  try {
    await store.saveServiceUrl('');
  } catch (error) {
    setStatus(`清除失败：${describeError(error)}`, 'error');
    return;
  }
  input.value = '';
  renderConfigured('');
  setStatus('已清除配置。', 'ok');
});

load();
