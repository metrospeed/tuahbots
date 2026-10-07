// Admin panel behavior. Served as /assets/admin.js so pages need no inline script.

// <form data-confirm="Are you sure?"> asks before submitting. The message is
// read as plain text, never evaluated, so names in it can't run as code.
document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-confirm]");
  if (form && !window.confirm(form.dataset.confirm)) event.preventDefault();
});

// <button data-copy="#selector"> copies that field's value.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const field = document.querySelector(button.dataset.copy);
  if (!field) return;
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = "Copied";
  } catch {
    field.select();
  }
});
