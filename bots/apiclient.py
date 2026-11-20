import aiohttp

# Centralized API utility
class APIClient:
    def __init__(self, base_url, token):
        self.base_url = base_url
        self.token = token

    def _url(self, endpoint):
        print(f"Constructing URL for endpoint: {endpoint}")
        separator = "&" if "?" in endpoint else "?"
        print(f"Using separator: {separator}")
        return f"{self.base_url}/{endpoint}{separator}token={self.token}"

    async def post_iamup(self, bot_version: str):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post((f"https://status.astroid.cc/monitor/iamup/{bot_version}")) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.post_iamup:", e)
            return {"error": str(e)}
    async def post(self, endpoint, data=None):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(self._url(endpoint), json=data) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.post:", e)
            return {"error": str(e)}

    async def get(self, endpoint):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(self._url(endpoint)) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.get:", e)
            return {"error": str(e)}

    async def delete(self, endpoint):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(self._url(endpoint)) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.delete:", e)
            return {"error": str(e)}
