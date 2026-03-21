import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.env.NODE_ENV = "production";

// ─── Intercept Express to inject user auth routes before catch-all ───
const { registerUserRoutes, initTables } = require("./user-auth.cjs");
const realExpress = require("express");
const origStatic = realExpress.static;

// Patch express.static to detect when the catch-all route is about to be added
// The app calls: app.use(express.static(publicDir)) then app.use("/{*path}", ...)
// We intercept the app.use call that sets up the catch-all
let _capturedApp = null;
const _origModule = require.cache[require.resolve("express")];
if (_origModule) {
  const origExports = _origModule.exports;
  const origFactory = origExports;
  // We need to wrap the Express factory to capture the app instance
  // But since index.cjs already required express, let's intercept at the app level
}

// Alternative approach: patch the 'use' method on Express apps to detect catch-all
const expressProto = realExpress.application || Object.getPrototypeOf(realExpress());
const origUse = expressProto.use;
let _routesInjected = false;

expressProto.use = function(...args) {
  // Detect the catch-all pattern: use("/{*path}", handler)
  // This is where index.cjs adds: app.use("/{*path}", (req, res) => res.sendFile(...))
  if (!_routesInjected && typeof args[0] === "string" && args[0].includes("{*path}")) {
    console.log("[server] Injecting user auth routes before catch-all");
    _routesInjected = true;
    _capturedApp = this;
    // Register our routes BEFORE the catch-all
    registerUserRoutes(this);
    // Initialize DB tables in background
    initTables().catch(err => console.error("[server] DB init error:", err.message));
  }
  return origUse.apply(this, args);
};

// Now load the main app
require("./dist/index.cjs");
