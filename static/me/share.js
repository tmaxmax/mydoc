function createForm() {
  const t = /** @type {HTMLTemplateElement} */ (document.createElement("template"));
  t.innerHTML = /* html */ `
    <form id="share-link" action="/auth/share" method="post">
      <button type="submit"><span>Share</span></button>
    </form>
  `;
  return /** @type {HTMLFormElement} */ (t.content.firstElementChild);
}

const form = createForm();
const button = form.querySelector("button");

function setFormState(cl) {
  form.classList.add(cl);
  button.disabled = true;
  setTimeout(() => {
    form.classList.remove(cl);
    button.disabled = false;
  }, 4000);
}

function copyFallback(text) {
  button.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      navigator.clipboard
        .writeText(text)
        .then(() => {
          form.classList.remove("copy");
          setFormState("success");
        })
        .catch((err) => {
          form.classList.remove("copy");
          setFormState("error");
          console.error(err);
        });
    },
    { once: true },
  );
  form.classList.add("copy");
}

form.addEventListener("submit", async (e) => {
  let text;
  try {
    e.preventDefault();

    const data = new FormData(form);
    data.set("path", window.location.pathname);

    const res = await fetch(form.action, {
      method: form.method,
      // @ts-ignore
      body: new URLSearchParams(data),
    });
    text = await res.text();

    if (res.ok) {
      text = new URL(text, window.location.origin).toString();
      await navigator.clipboard.writeText(text);
      setFormState("success");
    } else {
      throw new Error(text);
    }
  } catch (err) {
    if (text && err.name === "NotAllowedError") {
      copyFallback(text);
    } else {
      setFormState("error");
      console.error(err);
    }
  }
});

const target = /** @type {HTMLElement} */ (document.querySelector("[data-share-link-root]"));
target[target.dataset.shareLinkRoot || "append"](form);
