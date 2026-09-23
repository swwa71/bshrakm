const SERVER_BASE_URL = "https://pixels-pipes-lines-leaving.trycloudflare.com";

window.BushrakomServer = {
  baseUrl: SERVER_BASE_URL
};

// للتوافق مع أي ملف قديم يستخدم هذه الأسماء
window.SERVER_URL = SERVER_BASE_URL;
window.API_URL = SERVER_BASE_URL;

window.SERVER_CONFIG = {
  serverUrl: SERVER_BASE_URL,
  apiUrl: SERVER_BASE_URL
};

window.PORTAL_CONFIG = {
  serverUrl: SERVER_BASE_URL,
  apiUrl: SERVER_BASE_URL
};
