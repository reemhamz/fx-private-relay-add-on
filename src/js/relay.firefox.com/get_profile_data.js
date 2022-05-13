(async function () {
  const dahsboardInitializationObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      if (mutation.type !== "childList") {
        return;
      }
      mutation.addedNodes.forEach(node => {
        if (node.id !== "profile-main") {
          return;
        }

        // Once an element `#profile-main` is added, the dashboard is initialized
        // with the data needed by the add-on; stop watching for futher changes,
        // and run once:
        dahsboardInitializationObserver.disconnect();
        run();
      });
    });
  });
  if (document.getElementById("profile-main") === null) {
    dahsboardInitializationObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    run();
  }

  async function run() {
    // Get the api token from the account profile page
    const profileMainElement = document.querySelector("#profile-main");
    const apiToken = profileMainElement.dataset.apiToken;
    browser.storage.local.set({ apiToken });

    // API URL is ${RELAY_SITE_ORIGIN}/api/v1/
    const { relayApiSource } = await browser.storage.local.get("relayApiSource");

    const apiProfileURL = `${relayApiSource}/profiles/`;
    const apiRelayAddressesURL = `${relayApiSource}/relayaddresses/`;

    async function apiRequest(url, method = "GET", body = null, opts=null) {

      const cookieString =
        typeof document.cookie === "string" ? document.cookie : "";
      const cookieStringArray = cookieString
        .split(";")
        .map((individualCookieString) => individualCookieString.split("="))
        .map(([cookieKey, cookieValue]) => [
          cookieKey.trim(),
          cookieValue.trim(),
        ]);

      const [_csrfCookieKey, csrfCookieValue] = cookieStringArray.find(
        ([cookieKey, _cookieValue]) => cookieKey === "csrftoken"
      );

      browser.storage.local.set({ csrfCookieValue: csrfCookieValue });


      const headers = new Headers();


      headers.set("X-CSRFToken", csrfCookieValue);
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json");

      if (opts && opts.auth) {
        const apiToken = await browser.storage.local.get("apiToken");
        headers.set("Authorization", `Token ${apiToken.apiToken}`);
      }


      const response = await fetch(url, {
        mode: "same-origin",
        method,
        headers: headers,
        body,
      });

      const answer = await response.json();
      return answer;
    }

    const serverProfileData = await apiRequest(apiProfileURL);


    browser.storage.local.set({
      profileID: parseInt(serverProfileData[0].id, 10),
      settings: {
        server_storage: serverProfileData[0].server_storage,
      },
    });

    const siteStorageEnabled = serverProfileData[0].server_storage;


    // Check if user is premium
    // Note: for the non-React website, we would look at the DOM for the
    //       `is-premium` class. Starting with the React-based website, the
    //       Premium status is explicitly communicated with the add-on via a
    //       data property. In other words: if the website is in React when you
    //       encounter this, the first leg of the `||` can be removed.
    const isPremiumUser = document
      .querySelector("body")
      .classList.contains("is-premium") || document.querySelector(
        "firefox-private-relay-addon-data"
      ).dataset.hasPremium === "true";
    browser.storage.local.set({ premium: isPremiumUser });

    const localStorageRelayAddresses = [];

    // Get FXA Stuff
    const fxaSubscriptionsUrl = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.fxaSubscriptionsUrl;
    const premiumProdId = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.premiumProdId;
    const premiumPriceId = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.premiumPriceId;
    const aliasesUsedVal = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.aliasesUsedVal;
    const emailsForwardedVal = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.emailsForwardedVal;
    const emailsBlockedVal = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.emailsBlockedVal;
    const premiumSubdomainSet = document.querySelector(
      "firefox-private-relay-addon-data"
    ).dataset.premiumSubdomainSet;
    browser.storage.local.set({
      fxaSubscriptionsUrl,
      premiumProdId,
      premiumPriceId,
      aliasesUsedVal,
      emailsForwardedVal,
      emailsBlockedVal,
      premiumSubdomainSet,
    });

    // Loop through an array of aliases and see if any of them have descriptions or generated_for set.
    function aliasesHaveStoredMetadata(aliases) {
      for (const alias of aliases) {
        if (
          typeof alias.description === "string" &&
          alias.description.length > 0
        ) {
          return true;
        }

        if (typeof alias.generated_for === "string" && alias.generated_for.length > 0) {
          return true;
        }
      }
    }

    // Loop through local storage aliases and sync any metadata they have with the server dataset
    async function sendMetaDataToServer(aliases) {
      for (const alias of aliases) {
        const body = {
          description: alias.description ?? "",
          generated_for: alias.generated_for ?? "",
        };

        if (body.description.length > 0 || body.generated_for.length > 0) {
          await apiRequest(`${apiRelayAddressesURL}${alias.id}/`, "PATCH", JSON.stringify(body), {auth: true});
        }
      }
    }

    // Loop through the temp array that is about to be synced with the server dataset and
    // be sure it matches the local storage metadata dataset
    function getAliasesWithUpdatedMetadata(updatedAliases, prevAliases) {
      return prevAliases.map(prevAlias => {
        const updatedAlias = updatedAliases.find(otherAlias => otherAlias.id === prevAlias.id);
        return {
          ...prevAlias,
          description: updatedAlias.description.length > 0 ? updatedAlias.description : prevAlias.description,
          generated_for: updatedAlias.generated_for.length > 0 ? updatedAlias.generated_for : prevAlias.generated_for,
        };
      }
    )}

    if (siteStorageEnabled) {
      // Sync alias data from server page.
      // If local storage items exist AND have label metadata stored, sync it to the server.
      const serverRelayAddresses = await apiRequest(apiRelayAddressesURL);

      // let usage: This data may be overwritten when merging the local storage dataset with the server set.
      let localCopyOfServerRelayAddresses = serverRelayAddresses;

      // Check/cache local storage
      const { relayAddresses } = await browser.storage.local.get(
        "relayAddresses"
      );

      if (
        relayAddresses &&
        relayAddresses.length > 0 &&
        aliasesHaveStoredMetadata(relayAddresses) && // Make sure there is meta data in the local dataset
        !aliasesHaveStoredMetadata(localCopyOfServerRelayAddresses) // Make sure there is no meta data in the server dataset
      ) {
        await sendMetaDataToServer(relayAddresses);
        localCopyOfServerRelayAddresses = getAliasesWithUpdatedMetadata(
          localCopyOfServerRelayAddresses,
          relayAddresses
        );
      }

      browser.storage.local.set({ relayAddresses: localCopyOfServerRelayAddresses });
    } else {
      // Since the React version handles local storage of
      // label data by itself, we don't need to add our own listeners,
      // and we can just fetch label data from the API.
      const { relayAddresses: existingLocalStorageRelayAddresses } = await browser.storage.local.get(
        "relayAddresses"
      );

      // await browser.storage.local.set({ relayAddresses: {}} });



      if (localStorageRelayAddresses.length === 0 && existingLocalStorageRelayAddresses) {
        localStorageRelayAddresses.push(...existingLocalStorageRelayAddresses);
      }

      // Get data from server (Note: All description/generated_for fields should be BLANK)
      const serverRelayAddresses = await apiRequest(apiRelayAddressesURL);

      if (localStorageRelayAddresses.length === 0) {
        // Nothing local! Start fresh! 
        localStorageRelayAddresses.push(...serverRelayAddresses);
        browser.storage.local.set({ relayAddresses: localStorageRelayAddresses });
        return;
      }

      // WIP/DON'T SHIP: This is a scrape method for the website to grab know label descriptions
      // Actual fix should be to interacte with webpage local storage (however, localStorage does not have an labels stored currently) 
      const masks = document.querySelectorAll("div[class*='Alias_controls']");
      
      masks.forEach(mask => {
        const maskAddress = mask.querySelector("samp[class*='Alias_address']").textContent;
        const maskDescriptionValue = mask.querySelector("input[class*='LabelEditor_label-input']").value;

        const filteredMask = localStorageRelayAddresses.filter(mask => mask.full_address === maskAddress);

        if (filteredMask.length === 0) {
          throw new Error("No match found between local data and scrapped page data");
        }
        
        if (!filteredMask[0].description || filteredMask[0].description === "") {
          return;
        }

        filteredMask[0].description = maskDescriptionValue;
      });

      
      browser.storage.local.set({ relayAddresses: localStorageRelayAddresses });
    }

    document.querySelector(
      "firefox-private-relay-addon"
    ).addEventListener("website", async (event) => {
      if (event.detail.type === "labelUpdate") {
        const existingAddresses = (await browser.storage.local.get("relayAddresses")).relayAddresses;
        const update = event.detail;
        const oldAddress = existingAddresses.find(existingAddress =>
          existingAddress.id === update.alias.id &&
          existingAddress.address === update.alias.address &&
          existingAddress.domain === update.alias.domain
        );
        const newAddresses = existingAddresses.filter(existingAddress => existingAddress !== oldAddress);
        newAddresses.push({
          ...oldAddress,
          description: update.newLabel,
        });
        await browser.storage.local.set({ relayAddresses: newAddresses });
      }
    });

    await browser.runtime.sendMessage({
      method: "rebuildContextMenuUpgrade",
    });
  }
})();
