/**
 * SQySystems — Application logic
 * Vanilla ES6+ modules, Firebase Web SDK v10 (modular).
 *
 * Structure:
 *   1. Utilities        – DOM helpers, formatters
 *   2. Toast            – lightweight notifications
 *   3. Modal            – accessible dialogs (focus trap, ESC, backdrop)
 *   4. Site UI          – navbar, scroll effects, reveal animations, counters
 *   4b. HeroParallax    – scroll + pointer parallax for the hero background
 *   5. AuthService      – Firebase Auth + Firestore profile operations
 *   5b. MessageService  – saves contact-form submissions to the `messages` collection
 *   6. View             – renders guest / signed-in UI state
 *   7. Controllers      – forms (login, signup, profile, contact)
 *   8. Bootstrap        – wires everything and starts onAuthStateChanged
 */
import { auth, db, isFirebaseConfigured } from "./firebase-config.js";
import { findMerchantStore } from "./public/js/merchant-directory.js";
import { canManageAgency } from "./public/js/agency-model.js";
import { loginMerchant, resetMerchantPassword, logoutMerchant, merchantErrorMessage } from "./public/js/merchant-session.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  doc,
  collection,
  addDoc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

/* ============================================================
   1. Utilities
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const formatDate = (value) => {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !isNaN(date)
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    : "—";
};

const firstName = (name = "") => name.trim().split(/\s+/)[0] || "there";

const AUTH_ERRORS = {
  "auth/email-already-in-use": "An account with this email already exists.",
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/weak-password": "Password is too weak — use at least 6 characters.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "auth/operation-not-allowed": "Email/Password sign-in is not enabled in Firebase.",
  "permission-denied": "Permission denied. Check your Firestore security rules.",
};
const friendlyError = (err) =>
  err?.code?.startsWith("portal/") ? merchantErrorMessage(err) : AUTH_ERRORS[err?.code] || "Something went wrong. Please try again.";

function setLoading(button, loading) {
  button.classList.toggle("is-loading", loading);
  button.disabled = loading;
}

function setMessage(el, text = "", type = "error") {
  el.textContent = text;
  el.classList.toggle("is-error", Boolean(text) && type === "error");
  el.classList.toggle("is-success", Boolean(text) && type === "success");
}

function markInvalid(input, invalid) {
  input.setAttribute("aria-invalid", invalid ? "true" : "false");
}

/* ============================================================
   2. Toast
   ============================================================ */
const Toast = {
  show(message, type = "info", duration = 4000) {
    const region = $("#toasts");
    const el = document.createElement("div");
    el.className = `toast${type === "error" ? " toast--error" : ""}`;
    el.textContent = message;
    region.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, duration);
  },
};

/* ============================================================
   3. Modal
   ============================================================ */
const Modal = (() => {
  let active = null;
  let lastFocus = null;
  const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function open(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (active && active !== modal) close(active, false);
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    active = modal;
    requestAnimationFrame(() => $("input", modal)?.focus());
  }

  function close(modal = active, restoreFocus = true) {
    if (!modal) return;
    modal.hidden = true;
    $$("form", modal).forEach((f) => {
      f.reset();
      $$(".form__msg", f).forEach((m) => setMessage(m));
      $$("input", f).forEach((i) => markInvalid(i, false));
    });
    if (active === modal) {
      active = null;
      document.body.classList.remove("modal-open");
      if (restoreFocus) lastFocus?.focus?.();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key === "Escape") return close();
    if (e.key === "Tab") {
      const items = $$(FOCUSABLE, active).filter((el) => !el.hidden && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  return { open, close };
})();

/* ============================================================
   4. Site UI (navbar, reveal, counters, misc)
   ============================================================ */
const SiteUI = {
  init() {
    document.documentElement.classList.add("js");
    $("#year").textContent = new Date().getFullYear();
    this.logoFallback();
    this.navbar();
    this.reveal();
    this.scrollSpy();
    HeroParallax.init();
  },

  logoFallback() {
    // If logo.png is missing, hide the broken image and keep the text wordmark.
    const img = $("#brandLogo");
    img?.addEventListener("error", () => (img.style.display = "none"));
  },

  navbar() {
    const navbar = $("#navbar");
    const nav = $("#nav");
    const burger = $("#burger");

    const onScroll = () => navbar.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const setOpen = (open) => {
      nav.classList.toggle("is-open", open);
      burger.setAttribute("aria-expanded", String(open));
    };
    burger.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));
    nav.addEventListener("click", (e) => {
      if (e.target.closest("a, button")) setOpen(false);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#nav, #burger")) setOpen(false);
    });
    window.matchMedia("(min-width: 900px)").addEventListener("change", () => setOpen(false));
  },

  reveal() {
    const items = $$(".reveal");
    // Stagger siblings inside grids
    $$(".cards, .work-grid, .steps, .hero__stats").forEach((group) =>
      $$(".reveal", group).forEach((el, i) => el.style.setProperty("--d", `${i * 0.08}s`))
    );
    $$(".hero__inner > .reveal").forEach((el, i) => el.style.setProperty("--d", `${i * 0.08}s`));

    if (!("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("is-visible"));
      this.counters();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    items.forEach((el) => io.observe(el));
    this.counters();
  },

  counters() {
    const els = $$("[data-count]");
    const run = (el) => {
      const target = Number(el.dataset.count);
      const suffix = el.dataset.suffix || "";
      const duration = 1400;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (!("IntersectionObserver" in window)) return els.forEach(run);
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { run(e.target); io.unobserve(e.target); }
      });
    }, { threshold: 0.6 });
    els.forEach((el) => io.observe(el));
  },

  scrollSpy() {
    const links = $$(".nav__link[href^='#']");
    const map = new Map(links.map((l) => [l.getAttribute("href").slice(1), l]));
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((l) => l.classList.remove("is-active"));
          map.get(entry.target.id)?.classList.add("is-active");
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    map.forEach((_, id) => {
      const sec = document.getElementById(id);
      if (sec) io.observe(sec);
    });
  },
};

/* ============================================================
   4b. HeroParallax — layered scroll + pointer parallax
   Each element with [data-parallax="factor"] moves by factor × (scroll / pointer offset).
   Positive and negative factors move layers in different directions for depth.
   ============================================================ */
const HeroParallax = {
  init() {
    const hero = $(".hero");
    if (!hero) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const layers = $$("[data-parallax]", hero).map((el) => ({
      el,
      factor: parseFloat(el.dataset.parallax) || 0,
    }));
    if (!layers.length) return;

    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const pointer = { x: 0, y: 0 };   // current (smoothed), range -1..1
    const target = { x: 0, y: 0 };    // where the pointer actually is
    let scrollY = 0;
    let visible = true;
    let ticking = false;

    const render = () => {
      // Ease the pointer toward its target for a smooth, floaty feel
      pointer.x += (target.x - pointer.x) * 0.08;
      pointer.y += (target.y - pointer.y) * 0.08;

      for (const { el, factor } of layers) {
        const px = pointer.x * factor * 260;
        const py = pointer.y * factor * 260 + scrollY * factor * 1.6;
        el.style.setProperty("--px", `${px.toFixed(2)}px`);
        el.style.setProperty("--py", `${py.toFixed(2)}px`);
      }

      const settled = Math.abs(target.x - pointer.x) < 0.001 && Math.abs(target.y - pointer.y) < 0.001;
      ticking = false;
      if (!settled && visible) request();
    };

    const request = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(render);
      }
    };

    window.addEventListener("scroll", () => {
      scrollY = Math.min(window.scrollY, hero.offsetHeight);
      if (visible) request();
    }, { passive: true });

    if (canHover) {
      hero.addEventListener("pointermove", (e) => {
        const r = hero.getBoundingClientRect();
        target.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
        target.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
        request();
      });
      hero.addEventListener("pointerleave", () => {
        target.x = 0;
        target.y = 0;
        request();
      });
    }

    // Pause work while the hero is off-screen
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) request();
      }).observe(hero);
    }
    request();
  },
};

/* ============================================================
   5. AuthService — Firebase Auth + Firestore
   ============================================================ */
const AuthService = {
  /** Create the auth user, set display name, then store the profile in users/{uid}. */
  async signUp({ name, email, password }) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const { user } = cred;
    await updateProfile(user, { displayName: name });

    await setDoc(doc(db, "users", user.uid), {
      uid: user.uid,
      displayName: name,
      email: user.email,
      company: "",
      role: "client",
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
    return user;
  },

  login(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },

  logout() {
    return signOut(auth);
  },

  resetPassword(email) {
    return sendPasswordResetEmail(auth, email);
  },

  async getProfile(uid) {
    const snap = await getDocFromServer(doc(db, "users", uid));
    return snap.exists() ? snap.data() : null;
  },

  updateCompany(uid, company) {
    return updateDoc(doc(db, "users", uid), { company });
  },

  touchLastLogin(uid) {
    return updateDoc(doc(db, "users", uid), { lastLoginAt: serverTimestamp() });
  },
};

/* ============================================================
   5b. MessageService — contact form → Firestore `messages`
   Visitors don't need to be logged in; Firestore rules allow create-only access.
   ============================================================ */
const MessageService = {
  async send({ name, email, message }) {
    const payload = {
      name,
      email,
      message,
      uid: auth.currentUser?.uid ?? null,
      source: "website-contact-form",
      createdAt: serverTimestamp(),
    };
    return addDoc(collection(db, "messages"), payload);
  },
};

/* ============================================================
   6. View — renders guest / authenticated state
   ============================================================ */
const View = {
  renderGuest() {
    $$("[data-guest-only]").forEach((el) => (el.hidden = false));
    $$("[data-user-only], .is-auth-only").forEach((el) => (el.hidden = true));
    $("#dashboard").hidden = true;
    $("#navWelcome").textContent = "";
    $$("[data-sqy-admin]").forEach(el => { el.hidden = true; });

    // Remove contact-form values that were auto-filled from the previous user's account
    $$("#contactForm [data-prefilled]").forEach((input) => {
      input.value = "";
      delete input.dataset.prefilled;
    });
  },

  renderUser(user, profile) {
    const name = profile?.displayName || user.displayName || user.email.split("@")[0];

    $$("[data-guest-only]").forEach((el) => (el.hidden = true));
    $$("[data-user-only], .is-auth-only").forEach((el) => (el.hidden = false));
    $("#navWelcome").textContent = `Welcome, ${firstName(name)}`;
    $$("[data-sqy-admin]").forEach(el => { el.hidden = !canManageAgency(profile); });

    $("#dashboard").hidden = false;
    $("#dashWelcome").textContent = `Welcome, ${name}`;
    $("#dashName").textContent = name;
    $("#dashEmail").textContent = user.email;
    $("#dashCompany").textContent = profile?.company || "Not set";
    $("#dashStoreName").textContent = "Your store workspace is managed by SQySystems. Open the admin panel to sign in.";
    $("#dashSince").textContent = formatDate(profile?.createdAt || user.metadata?.creationTime);
    $("#dashUid").textContent = user.uid;
    $("#companyInput").value = profile?.company || "";

    // Pre-fill the contact form for signed-in users (never overwrite what they typed)
    const cName = $("#contactName");
    const cEmail = $("#contactEmail");
    if (cName && !cName.value) { cName.value = name; cName.dataset.prefilled = "1"; }
    if (cEmail && !cEmail.value) { cEmail.value = user.email; cEmail.dataset.prefilled = "1"; }
  },
};

/* ============================================================
   7. Controllers
   ============================================================ */
const state = {
  user: null,
  profile: null,
  signingUp: false, // prevents the auth observer from racing the profile write
  stopProfile: null,
  authEpoch: 0,
};

async function refreshProfile(user) {
  try {
    state.profile = await AuthService.getProfile(user.uid);
  } catch (err) {
    console.warn("[SQySystems] Could not load profile:", err.code || err);
    state.profile = null;
  }
  if (auth.currentUser?.uid === user.uid) View.renderUser(user, state.profile);
}

function initModalTriggers() {
  document.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-modal]");
    if (openBtn) return Modal.open(openBtn.dataset.openModal);

    const switchBtn = e.target.closest("[data-switch-modal]");
    if (switchBtn) return Modal.open(switchBtn.dataset.switchModal);

    if (e.target.closest("[data-close-modal]")) return Modal.close();

    if (e.target.closest("[data-logout]")) handleLogout();
  });
}

function guardConfig(msgEl) {
  if (isFirebaseConfigured) return true;
  setMessage(msgEl, "Firebase is not configured yet. Add your keys in firebase-config.js.");
  return false;
}

function initLoginForm() {
  const form = $("#loginForm");
  const email = $("#loginEmail");
  const password = $("#loginPassword");
  const msg = $("#loginMsg");
  const submit = $("#loginSubmit");
  const forgot = $("#forgotBtn");
  let busy = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    setMessage(msg);
    const emailVal = email.value.trim();
    const bad = !EMAIL_RE.test(emailVal);
    markInvalid(email, bad);
    markInvalid(password, !password.value);
    if (bad) return setMessage(msg, "Please enter a valid email address.");
    if (!password.value) return setMessage(msg, "Please enter your password.");
    const enteredPassword = password.value;
    password.value = "";
    busy = true;
    forgot.disabled = true;
    setLoading(submit, true);
    try {
      // One authoritative Master directory lookup before choosing the auth
      // project. Disabled/malformed/network failures never fall back to Master.
      const merchant = await loginMerchant(emailVal, enteredPassword, { allowAgencyAccount: true });
      if (merchant) {
        Modal.close();
        window.location.assign(new URL("./public/admin.html", import.meta.url).href);
      } else {
        if (!guardConfig(msg)) return;
        await AuthService.login(emailVal, enteredPassword);
        Modal.close();
      }
    } catch (err) {
      setMessage(msg, err?.code?.startsWith("portal/") ? merchantErrorMessage(err) : friendlyError(err));
    } finally {
      busy = false;
      forgot.disabled = false;
      setLoading(submit, false);
    }
  });
  forgot.addEventListener("click", async () => {
    if (busy) return;
    const emailVal = email.value.trim();
    if (!EMAIL_RE.test(emailVal)) {
      markInvalid(email, true);
      email.focus();
      return setMessage(msg, "Enter your email above, then click “Forgot password?”.");
    }
    busy = true;
    forgot.disabled = true;
    setLoading(submit, true);
    try {
      const merchant = await resetMerchantPassword(emailVal, { allowAgencyAccount: true });
      if (!merchant) {
        if (!guardConfig(msg)) return;
        await AuthService.resetPassword(emailVal);
      }
      setMessage(msg, "If this account exists, a password reset email will arrive shortly.", "success");
    } catch (err) {
      setMessage(msg, err?.code?.startsWith("portal/") ? merchantErrorMessage(err) : friendlyError(err));
    } finally {
      busy = false;
      forgot.disabled = false;
      setLoading(submit, false);
    }
  });
}

function initSignupForm() {
  const form = $("#signupForm");
  const name = $("#signupName");
  const email = $("#signupEmail");
  const password = $("#signupPassword");
  const msg = $("#signupMsg");
  const submit = $("#signupSubmit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMessage(msg);

    const nameVal = name.value.trim();
    const emailVal = email.value.trim();
    const checks = [
      [name, nameVal.length >= 2, "Please enter your full name."],
      [email, EMAIL_RE.test(emailVal), "Please enter a valid email address."],
      [password, password.value.length >= 6, "Password must be at least 6 characters."],
    ];
    for (const [input, ok] of checks) markInvalid(input, !ok);
    const failed = checks.find(([, ok]) => !ok);
    if (failed) return setMessage(msg, failed[2]);
    if (!guardConfig(msg)) return;

    setLoading(submit, true);
    state.signingUp = true;
    try {
      if (await findMerchantStore(emailVal)) {
        state.signingUp = false;
        return setMessage(msg, "Your store account is managed by SQySystems. Please log in with your existing store credentials.");
      }
      const user = await AuthService.signUp({ name: nameVal, email: emailVal, password: password.value });
      state.signingUp = false;
      Modal.close();
      await refreshProfile(auth.currentUser || user);
      Toast.show(`Account created. Welcome, ${firstName(nameVal)}!`);
    } catch (err) {
      state.signingUp = false;
      setMessage(msg, friendlyError(err));
    } finally {
      setLoading(submit, false);
    }
  });
}

function initProfileForm() {
  const form = $("#profileForm");
  const input = $("#companyInput");
  const msg = $("#profileMsg");
  const submit = $("#profileSave");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.user) return;
    setMessage(msg);
    setLoading(submit, true);
    try {
      const company = input.value.trim().slice(0, 80);
      await AuthService.updateCompany(state.user.uid, company);
      state.profile = { ...(state.profile || {}), company };
      $("#dashCompany").textContent = company || "Not set";
      setMessage(msg, "Saved.", "success");
      Toast.show("Profile updated.");
    } catch (err) {
      setMessage(msg, friendlyError(err));
    } finally {
      setLoading(submit, false);
    }
  });
}

function initContactForm() {
  const form = $("#contactForm");
  if (!form) return;

  const name = $("#contactName");
  const email = $("#contactEmail");
  const message = $("#contactMessage");
  const honeypot = $("#contactWebsite");
  const count = $("#contactCount");
  const msg = $("#contactMsg");
  const submit = $("#contactSubmit");
  const COOLDOWN_MS = 20000; // basic client-side spam protection
  let lastSent = 0;

  // Typing again clears the "prefilled" flag so logging out won't wipe user-edited text
  [name, email].forEach((i) => i.addEventListener("input", () => delete i.dataset.prefilled));
  message.addEventListener("input", () => (count.textContent = message.value.length));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMessage(msg);

    // Bots fill the hidden field; pretend success and drop the submission
    if (honeypot.value) {
      form.reset();
      return Toast.show("Thanks! Your message has been sent.");
    }

    const nameVal = name.value.trim();
    const emailVal = email.value.trim();
    const messageVal = message.value.trim();

    const checks = [
      [name, nameVal.length >= 2, "Please enter your name."],
      [email, EMAIL_RE.test(emailVal), "Please enter a valid email address."],
      [message, messageVal.length >= 10, "Your message should be at least 10 characters."],
    ];
    checks.forEach(([input, ok]) => markInvalid(input, !ok));
    const failed = checks.find(([, ok]) => !ok);
    if (failed) {
      setMessage(msg, failed[2]);
      failed[0].focus();
      return;
    }

    if (!isFirebaseConfigured) {
      setMessage(msg, "Firebase is not configured yet. Add your keys in firebase-config.js.");
      return Toast.show("Message could not be sent: Firebase is not configured.", "error");
    }

    if (Date.now() - lastSent < COOLDOWN_MS) {
      setMessage(msg, "Please wait a few seconds before sending another message.");
      return;
    }

    setLoading(submit, true);
    try {
      await MessageService.send({ name: nameVal, email: emailVal, message: messageVal });
      lastSent = Date.now();
      form.reset();
      count.textContent = "0";
      checks.forEach(([input]) => markInvalid(input, false));
      delete name.dataset.prefilled;
      delete email.dataset.prefilled;
      setMessage(msg, "Message sent — we'll get back to you within one business day.", "success");
      Toast.show(`Thanks, ${firstName(nameVal)}! Your message has been sent.`);
      // Re-apply prefill for signed-in users after reset
      if (state.user) View.renderUser(state.user, state.profile);
    } catch (err) {
      console.warn("[SQySystems] Contact form error:", err.code || err);
      setMessage(msg, friendlyError(err));
      Toast.show("Sorry, your message could not be sent. Please try again.", "error");
    } finally {
      setLoading(submit, false);
    }
  });
}

async function handleLogout() {
  try {
    await Promise.all([AuthService.logout(), logoutMerchant()]);
    Toast.show("You have been logged out.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    Toast.show(friendlyError(err), "error");
  }
}

/* ============================================================
   8. Bootstrap
   ============================================================ */
function init() {
  SiteUI.init();
  initModalTriggers();
  initLoginForm();
  initSignupForm();
  initProfileForm();
  initContactForm();
  View.renderGuest();

  if (!isFirebaseConfigured) {
    console.warn("[SQySystems] Firebase keys are placeholders. Edit firebase-config.js to enable authentication.");
    return;
  }

  // Single source of truth for authentication state.
  onAuthStateChanged(auth, async (user) => {
    const ticket = ++state.authEpoch;
    state.stopProfile?.();
    state.stopProfile = null;
    state.user = user;
    $$("[data-sqy-admin]").forEach(el => { el.hidden = true; });

    if (!user) {
      state.profile = null;
      View.renderGuest();
      return;
    }

    // During sign-up the profile document is still being written; signUp handler renders afterwards.
    if (state.signingUp) return;

    await refreshProfile(user);
    if (ticket !== state.authEpoch || auth.currentUser?.uid !== user.uid) return;
    state.stopProfile = onSnapshot(doc(db, "users", user.uid), { includeMetadataChanges: true }, snapshot => {
      if (ticket !== state.authEpoch || auth.currentUser?.uid !== user.uid || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      state.profile = snapshot.exists() ? snapshot.data() : null;
      View.renderUser(user, state.profile);
    }, () => { if (ticket === state.authEpoch) $$("[data-sqy-admin]").forEach(el => { el.hidden = true; }); });
    AuthService.touchLastLogin(user.uid).catch(() => {});
  });
}

init();
