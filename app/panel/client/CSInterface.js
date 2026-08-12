/*
 * Minimal CSInterface — just enough to run ExtendScript from the panel.
 *
 * The full Adobe CSInterface.js (from the CEP SDK) has many more helpers, but
 * this panel only needs to send a script to Premiere and get the result back.
 * CEP injects window.__adobe_cep__ automatically when the panel loads.
 */
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof callback !== "function") callback = function () {};
    window.__adobe_cep__.evalScript(script, callback);
};
