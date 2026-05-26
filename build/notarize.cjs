const { notarize } = require("@electron/notarize");

exports.default = async function notarizeIfConfigured(context) {
  if (process.platform !== "darwin" || process.env.KRT_NOTARIZE !== "true") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    throw new Error("KRT_NOTARIZE=true requires APPLE_ID, APPLE_ID_PASSWORD, and APPLE_TEAM_ID.");
  }

  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath: `${context.appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId
  });
};
