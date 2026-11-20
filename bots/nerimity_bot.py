import nerimity
import asyncio
import os
import traceback
from dotenv import load_dotenv
from apiclient import APIClient

load_dotenv()

api_url = os.getenv("API_URL")

client = nerimity.Client(
    token=os.getenv("NERIMITY_TOKEN"),
    prefix='ab!',
)

# Initialize API client
api_client = APIClient(api_url, os.getenv("MASTER_TOKEN"))


async def send_iamup():
    response = await api_client.post_iamup("nerimity")
    if response:
        print("Sent up status.")
    else:
        print("Could not send up status.")


async def iamup_loop():
    while True:
        asyncio.create_task(send_iamup())
        await asyncio.sleep(40)


@client.listen("on_message_create")
async def on_message_created(message: nerimity.Message):
    if message.content.startswith("ab!") or message.content.startswith("gcb!"):
        return

    data = await api_client.get(f"getendpoint/nerimity?serverid={nerimity.Context(message).server.id}")
    endpoint = data.get("discord")
    if not endpoint:
        return

    try:
        if str(message.author.id) in ["1528027225549611008", "1570083374897479680"]:
            return

        config_data = await api_client.get(f"{endpoint}")
        if "config" not in config_data:
            return

        is_beta = config_data["config"].get("isbeta")
        if not is_beta:
            avatar = message.author.avatar
            if avatar and avatar != "None":
                author_avatar = f"https://cdn.nerimity.com/{avatar}"
            else:
                author_avatar = f"{api_url}/assets/Astroid PFP not found.png"

            content = message.content if message.content != "None" else ""

            msg_obj = {
                "content": content,
                "author": {
                    "name": message.author.username,
                    "avatar": author_avatar,
                    "id": str(message.author.id)
                },
                "sender": "nerimity",
                "sender-channel": str(message.channel_id)
            }

            if message.attachments:
                msg_obj["attachments"] = [f"https://cdn.nerimity.com/{a.path}" for a in message.attachments]

            if message.quoted_messages:
                try:
                    quoted = message.quoted_messages[0]
                    quoted_author = quoted.get("createdBy") or {}
                    msg_obj["isReply"] = True
                    msg_obj["reply"] = {
                        "author": quoted_author.get("username"),
                        "message": quoted.get("content")
                    }
                except Exception:
                    traceback.print_exc()

            response = await api_client.post(f"{endpoint}/messages", data=msg_obj)
            print(f"Message sent to API: {response}")
    except:
        traceback.print_exc()


@client.slash_command(name="register", description="Register this server with the specified endpoint.")
async def register(ctx: nerimity.Context, endpoint: str = None, *_extra):
    if not endpoint:
        await ctx.send("Missing parameter: `endpoint`.\n Usage: `ab!register [endpoint]`")
        return
    try:
        endpoint = int(endpoint)
    except ValueError as e:
        await ctx.send(f"Invalid endpoint. Please provide a valid endpoint. (Detail: `{e}`)")
        return
    if ctx.author.id == client.account.id:
        return

    data = await api_client.get(f"getendpoint/nerimity?serverid={ctx.server.id}")
    existing = data.get("discord")
    if existing:
        if str(existing) == str(endpoint):
            await ctx.send("Endpoint already registered.")
        else:
            await ctx.send("This server is registered with another endpoint. For further assistance, please contact the support server.")
        return

    try:
        created = await api_client.post("createendpoint/nerimity", data={"endpoint": endpoint, "id": str(ctx.server.id)})
        if not created or created.get("message") != "Success.":
            await ctx.send(f"Oops, something went wrong: `{created.get('message') if created else 'No response from API.'}`")
            return
        await ctx.send(f"Registered endpoint: {api_url}/{endpoint}")
    except Exception as e:
        await ctx.send(f"An error occurred while trying to register the endpoint. Please report this in the [Support Server](https://nerimity.com/i/fgE6q). \n\n`{e}`")
        return

    try:
        channel_id = ctx.channel.id
        updated = await api_client.post(f"{endpoint}/config", data={"channels": {"nerimity": [str(channel_id)]}})
        if updated and "message" not in updated:
            await ctx.send(f"Updated endpoint: {api_url}/{endpoint}")
        else:
            await ctx.send(f"Oops, something went wrong: `{updated.get('message') if updated else 'No response from API.'}`")
    except Exception as e:
        await ctx.send(f"An error occurred while trying to update the endpoint. Please report this in the [Support Server](https://nerimity.com/i/fgE6q). \n\n`{e}`")


@client.slash_command(name="addbridge", description="Add this channel to the bridge for the registered endpoint.")
async def add_bridge(ctx: nerimity.Context, *_extra):
    data = await api_client.get(f"getendpoint/nerimity?serverid={ctx.server.id}")
    endpoint = data.get("discord")
    if not endpoint:
        await ctx.send(":x: - Your endpoint could not be found.")
        return
    await api_client.post(f"{endpoint}/config", data={"channels": {"nerimity": [str(ctx.channel.id)]}})
    await ctx.send(f"Updated endpoint: {api_url}/{endpoint}")


@client.listen("on_ready")
async def on_ready(client_info: dict):
    print(f"Logged in as {client.account.username}#{client.account.tag}")
    asyncio.create_task(iamup_loop())

client.run()
