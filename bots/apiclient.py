import aiohttp

# Centralized API utility
class APIClient:
    def __init__(self, base_url, token):
        self.base_url = base_url
        self.token = token

    async def post(self, endpoint, data=None):
        try:
            url = f"{self.base_url}/{endpoint}?token={self.token}"
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=data) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.post:", e)
            return {"error": str(e)}

    async def get(self, endpoint):
        try:
            url = f"{self.base_url}/{endpoint}?token={self.token}"
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.get:", e)
            return {"error": str(e)}
    async def delete(self, endpoint):
        try:
            url = f"{self.base_url}/{endpoint}?token={self.token}"
            async with aiohttp.ClientSession() as session:
                async with session.delete(url) as response:
                    return await response.json()
        except Exception as e:
            print("Error in APIClient.delete:", e)
            return {"error": str(e)}