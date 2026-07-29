export default {
  async fetch(request, environment) {
    if (environment?.ASSETS?.fetch === undefined) {
      return new Response("Static asset binding is unavailable.", {
        status: 503,
      });
    }

    const response = await environment.ASSETS.fetch(request);
    if (response.status !== 404) {
      return response;
    }

    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = "/index.html";
    return environment.ASSETS.fetch(new Request(fallbackUrl, request));
  },
};
