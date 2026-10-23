// Compatibility entrypoint for older operator checkouts. There is no bulk reset.
// Forward explicit report/apply arguments to the exact-message reconciler.
if (process.argv.length === 2) {
  console.error('Bulk incident reset is unavailable. Keep the worker stopped.');
  console.error('First: npm run recovery:diagnose -- --message-id <private Gmail ID>');
  console.error('Then: npm run recovery:report -- --help');
  console.error('Repair requires current provider evidence and an exact reviewed report hash.');
  process.exitCode = 2;
} else {
  await import('./reconcile_deal_email');
}
