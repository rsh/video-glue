/**
 * Login + registration forms (kept from template, unchanged behavior).
 */

export function createLoginForm(): HTMLElement {
  const form = document.createElement("form");
  form.className = "card p-4";
  form.innerHTML = `
    <h2 class="mb-3">Login</h2>
    <div class="mb-3">
      <label for="email" class="form-label">Email</label>
      <input type="email" class="form-control" id="email" name="email" required>
    </div>
    <div class="mb-3">
      <label for="password" class="form-label">Password</label>
      <input type="password" class="form-control" id="password" name="password" required>
    </div>
    <button type="submit" class="btn btn-primary">Login</button>
    <button type="button" class="btn btn-link" id="switch-to-register">
      Don't have an account? Register
    </button>
  `;
  return form;
}

export function createRegisterForm(): HTMLElement {
  const form = document.createElement("form");
  form.className = "card p-4";
  form.innerHTML = `
    <h2 class="mb-3">Register</h2>
    <div class="mb-3">
      <label for="username" class="form-label">Username</label>
      <input type="text" class="form-control" id="username" name="username" required minlength="3">
    </div>
    <div class="mb-3">
      <label for="email" class="form-label">Email</label>
      <input type="email" class="form-control" id="email" name="email" required>
    </div>
    <div class="mb-3">
      <label for="password" class="form-label">Password</label>
      <input type="password" class="form-control" id="password" name="password" required minlength="8">
    </div>
    <button type="submit" class="btn btn-primary">Register</button>
    <button type="button" class="btn btn-link" id="switch-to-login">
      Already have an account? Login
    </button>
  `;
  return form;
}
