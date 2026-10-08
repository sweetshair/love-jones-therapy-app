// Use the existing project's public browser configuration, never a key from the link.
const firebaseConfig = {
  apiKey: "AIzaSyAd8Fj3RRYXEju1z1ZfdW6351IGlN88Ono",
  authDomain: "love-jones-therapy-app.firebaseapp.com",
  projectId: "love-jones-therapy-app",
  appId: "1:551807483051:web:65106d020f51c5a3b88bee"
};

export function parseAction(search) {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const code = params.get("oobCode");
  const operations = {
    verifyEmail: "VERIFY_EMAIL",
    resetPassword: "PASSWORD_RESET",
    recoverEmail: "RECOVER_EMAIL",
    verifyAndChangeEmail: "VERIFY_AND_CHANGE_EMAIL"
  };
  if (!Object.hasOwn(operations, mode) || !code || code.length > 4096
      || params.getAll("mode").length !== 1 || params.getAll("oobCode").length !== 1
      || (params.has("apiKey") && params.get("apiKey") !== firebaseConfig.apiKey)) {
    throw new Error("invalid-link");
  }
  return { mode, code, operation: operations[mode] };
}

function failureMessage(error) {
  if (error?.code === "auth/network-request-failed") {
    return "We could not connect. Check your internet connection and reopen the link from your email.";
  }
  if (["auth/weak-password", "auth/password-does-not-meet-requirements"].includes(error?.code)) {
    return "Choose a stronger password that meets your account’s password requirements.";
  }
  if (error?.code === "auth/too-many-requests") {
    return "Too many attempts. Please wait a little and try again.";
  }
  return "This link is invalid, expired, or already used. Return to First Option Dating to request a new email.";
}

export async function handleAction(action, sdk, auth, view) {
  try {
    // Check the server-side action type before consuming any one-time code.
    const info = await sdk.checkActionCode(auth, action.code);
    if (info.operation !== action.operation) throw new Error("invalid-link");
    if (action.mode === "resetPassword") {
      await sdk.verifyPasswordResetCode(auth, action.code);
      view.status("Reset your password", "Enter and confirm your new password.");
      let saving = false;
      view.reset(async (password, confirmation) => {
        if (saving) return;
        if (password.length < 6 || password.length > 4096) {
          view.status("Reset your password", "Use a password with at least 6 characters.");
          return;
        }
        if (password !== confirmation) {
          view.status("Reset your password", "Your passwords do not match. Please try again.");
          return;
        }
        saving = true;
        view.busy(true);
        try {
          await sdk.confirmPasswordReset(auth, action.code, password);
          view.hideReset();
          view.status("Password updated", "Your new password is saved. Return to First Option Dating and sign in.");
        } catch (error) {
          view.status("Password not updated", failureMessage(error));
        } finally {
          view.clearPasswords();
          view.busy(false);
          saving = false;
        }
      });
      return;
    }
    await sdk.applyActionCode(auth, action.code);
    const messages = {
      verifyEmail: ["Email verified", "Your email address is verified. Return to First Option Dating to continue. If the app still asks for verification, refresh your verification status or sign in again."],
      recoverEmail: ["Email address restored", "Your previous email address has been restored. If you did not make the change, return to First Option Dating and use Forgot password to secure your account."],
      verifyAndChangeEmail: ["Email address updated", "Your new email address is confirmed. Return to First Option Dating and sign in with it."]
    };
    view.status(...messages[action.mode]);
  } catch (error) {
    view.hideReset();
    view.status("Link could not be completed", failureMessage(error));
  }
}

async function boot() {
  const form = document.getElementById("reset-form");
  const password = document.getElementById("password");
  const confirmation = document.getElementById("confirm-password");
  const button = document.getElementById("reset-button");
  const view = {
    status(title, message) {
      document.getElementById("heading").textContent = title;
      document.getElementById("status").textContent = message;
    },
    reset(submit) {
      form.hidden = false;
      form.addEventListener("submit", event => {
        event.preventDefault();
        void submit(password.value, confirmation.value);
      });
      password.focus();
    },
    hideReset() { form.hidden = true; password.value = confirmation.value = ""; },
    busy(value) { button.disabled = password.disabled = confirmation.disabled = value; },
    clearPasswords() { password.value = confirmation.value = ""; }
  };
  try {
    const action = parseAction(window.location.search);
    // Keep one-time codes out of history and subsequent same-page resource URLs.
    window.history.replaceState(null, "", window.location.pathname);
    const [appSDK, sdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js")
    ]);
    // A separate in-memory instance cannot replace the member's saved login.
    const app = appSDK.initializeApp(firebaseConfig, "email-action-handler");
    const auth = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence });
    await handleAction(action, sdk, auth, view);
  } catch (error) {
    view.hideReset();
    view.status("Link could not be completed", failureMessage(error));
  }
}

if (typeof document !== "undefined") void boot();
