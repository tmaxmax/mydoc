"use strict";

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");
const darkModeInput = /** @type {HTMLFieldSetElement} */ (document.querySelector("#dark-mode"));
const darkModeStorageKey = "darkMode";

function prefersDarkMode() {
  const value = window.localStorage.getItem(darkModeStorageKey);
  if (!value) {
    return null;
  }
  return value === "true";
}

/** @param {boolean | null} isDark */
function darkModeToInput(isDark) {
  return isDark === null ? "system" : isDark === darkMode.matches ? "self" : "other";
}

/** @param {boolean | null} isDark */
function setDarkMode(isDark) {
  /** @type {HTMLInputElement} */ (darkModeInput.querySelector(":checked")).checked = false;
  /** @type {HTMLInputElement} */ (darkModeInput.querySelector(`#dark-${darkModeToInput(isDark)}`)).checked = true;
}

darkModeInput.addEventListener("change", (e) => {
  const { value } = /** @type {HTMLInputElement} */ (e.target);
  const isDark = value === "self" ? darkMode.matches : value === "other" ? !darkMode.matches : null;
  if (isDark !== null) {
    window.localStorage.setItem(darkModeStorageKey, isDark.toString());
  } else {
    window.localStorage.removeItem(darkModeStorageKey);
  }
});

window.addEventListener("storage", (e) => {
  if (e.key === darkModeStorageKey) {
    setDarkMode(e.newValue === null ? null : e.newValue === "true");
  }
});

darkMode.addEventListener("change", () => {
  setDarkMode(prefersDarkMode());
});

setDarkMode(prefersDarkMode());
darkModeInput.classList.add("system");
