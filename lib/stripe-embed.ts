/**
 * Stripe's embedded payment form. The form is an iframe served by Stripe: card
 * and bank details are typed into it and never reach this page's code. This file
 * only loads Stripe's script and mounts the form where we ask.
 */
type EmbeddedCheckout = { mount: (target: HTMLElement) => void; destroy: () => void };
type StripeInstance = { initEmbeddedCheckout: (options: { clientSecret: string; onComplete?: () => void }) => Promise<EmbeddedCheckout> };
declare global { interface Window { Stripe?: (publishableKey: string) => StripeInstance } }

let scriptPromise: Promise<void> | null = null;

function loadStripeScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { scriptPromise = null; reject(new Error("Stripe's payment form could not be loaded.")); };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

/** Mounts the form into `target`. Returns a function that removes it. */
export async function mountEmbeddedCheckout(target: HTMLElement, options: { clientSecret: string; publishableKey: string; onComplete: () => void }): Promise<() => void> {
  await loadStripeScript();
  if (!window.Stripe) throw new Error("Stripe's payment form could not be loaded.");
  const checkout = await window.Stripe(options.publishableKey).initEmbeddedCheckout({ clientSecret: options.clientSecret, onComplete: options.onComplete });
  checkout.mount(target);
  return () => checkout.destroy();
}
