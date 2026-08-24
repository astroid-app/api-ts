import nerimity
import config
import pathlib
import json
import aiohttp
import asyncio
import os
import traceback
import requests
from apiclient import APIClient



client = nerimity.Client(
    token=config.NERIMITY_TOKEN,
    prefix='ab!',
)

# Initialize API client
api_client = APIClient("https://api.astroid.cc", config.MASTER_TOKEN)

async def send_message(endpoint, params):
    async with aiohttp.ClientSession() as session:
        async with session.post(f"https://api.astroid.cc/update/{endpoint}?{params}&token={config.MASTER_TOKEN}") as resp:
            return await resp.json()

# Replace send_iamup with API client usage
async def send_iamup():
    response = await api_client.post("monitor/iamup/nerimity-beta")
    if response:
        print("Sent up status.")
    else:
        print("Could not send up status.")

async def create_webhook(server_id, channel_id):
    async with aiohttp.ClientSession() as session:
        async with session.post(f"https://nerimity.com/api/servers/{server_id}/channels/{channel_id}/webhooks") as resp:
            r_1_json = await resp.json()
            if r_1_json and resp.status == 200:
                webhook_id = r_1_json["id"]
                async with session.get(f"https://nerimity.com/api/servers/{server_id}/channels/{channel_id}/webhooks/{webhook_id}/token") as r_2:
                    if r_2.status == 200:
                        r_2_json = await r_2.json()
                        return f"https://nerimity.com/api/webhooks/{webhook_id}/{r_2_json['token']}"
            else:
                return None

async def iamup_loop():
    while True:
        asyncio.create_task(send_iamup())
        await asyncio.sleep(40)


@client.listen("on_message_create")
async def on_message_created(_message):
    message = nerimity.Message.deserialize(_message["message"])
    if message.content.startswith("ab!") or message.content.startswith("gcb!"):
        return
    async with aiohttp.ClientSession() as session:
        async with session.get(f"https://api.astroid.cc/getendpoint/nerimity?id={nerimity.Context(message).server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                endpoint = data["discord"]
                if not endpoint:
                    return
            except:
                return
    try:
        if str(message.author.id) in ["1528027225549611008", "1570083374897479680"]:
            return
        async with aiohttp.ClientSession() as session:
            async with session.get(f"https://api.astroid.cc/{endpoint}?token={config.MASTER_TOKEN}") as resp:
                data = await resp.json()
                is_beta = data["config"]["isbeta"]
                if is_beta:
                    print(message.author.avatar)
                    if message.author.avatar:
                        author_avatar = f"https://cdn.nerimity.com/{message.author.avatar}"
                    else:
                        author_avatar = "https://astroid.cc/assets/Astroid PFP not found.png"
                    if message.attachments:
                        if len(message.attachments) == 1:
                            params = f"message_author_id={message.author.id}&message_author_name={message.author.username}&message_author_avatar={author_avatar}"\
                            f"&message_content={message.content}&sender=nerimity&sender_channel={message.channel_id}&trigger=true&message_attachments=https://cdn.nerimity.com/{message.attachments[0].path}"
                            if not message.quoted_messages:
                                await send_message(endpoint, params)
                            else:
                                quoted_message = message.quoted_messages[0]  
                                params = f"message_author_id={message.author.id}&message_author_name={message.author.username}&message_author_avatar={author_avatar}"\
                                f"&message_content={message.content}&sender=nerimity&sender_channel={message.channel_id}&trigger=true&message_attachments={message.attachments[0].path}&message_reply=true&message_reply_message={quoted_message.author.id}&message_reply_author={quoted_message.author.username}&message_reply_message={quoted_message.content}"
                                await send_message(endpoint, params)
                        else:
                            attachments = ""
                            for attachment in message.attachments:
                                attachments += f"https://cdn.nerimity.com/{attachment.path},"
                            params = f"message_author_id={message.author.id}&message_author_name={message.author.username}&message_author_avatar={author_avatar}"\
                            f"&message_content={message.content}&sender=nerimity&sender_channel={message.channel_id}&trigger=true&message_attachments={attachments[:-1]}"
                    if not message.attachments:
                        params = f"message_author_id={message.author.id}&message_author_name={message.author.username}&message_author_avatar={author_avatar}"\
                        f"&message_content={message.content}&sender=nerimity&sender_channel={message.channel_id}&trigger=true"
                        if message.quoted_messages:
                            quoted_message = message.quoted_messages[0]
                            params += f"&message_reply=true&message_reply_message={quoted_message.author.id}&message_reply_author={quoted_message.author.username}&message_reply_message={quoted_message.content}"
                        await send_message(endpoint, params)
    except:
        traceback.print_exc()
        pass


@client.command()
async def register(ctx: nerimity.Context, params: str):
    print(params)
    try:
        int(params[0])
    except Exception as e:
        await ctx.respond(f"Invalid endpoint. Please provide a valid endpoint. (Detail: `{e}`)")
        return
    endpoint = int(params[0])
    if ctx.author.id == client.account.id:
        return
    if len(params) == 0:
        await ctx.respond("Missing parameter: `endpoint`.\n Usage: `ab!register [endpoint]`")
        return
    
    async with aiohttp.ClientSession() as session:
        async with session.get(f"https://api.astroid.cc/getendpoint/nerimity?id={ctx.server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                _endpoint = data["discord"]
                if _endpoint == endpoint:
                    await ctx.send("Endpoint already registered.")
                    return
                else:
                    await ctx.send("This server is registered with another endpoint. For further assistance, please contact the support server.")
            except KeyError:
                async with aiohttp.ClientSession() as session: 
                    async with session.post(f"https://api.astroid.cc/createendpoint/nerimity?endpoint={endpoint}&id={ctx.server.id}&token={config.MASTER_TOKEN}") as response:
                        if response.status == 200:
                            await ctx.send(f"Registered endpoint: https://api.astroid.cc/{endpoint}")
                        else:
                            await ctx.send(f"Oops, something went wrong: `{data['message']}`")
            except IndexError:
                async with aiohttp.ClientSession() as session: 
                    async with session.post(f"https://api.astroid.cc/createendpoint/nerimity?endpoint={endpoint}&id={ctx.server.id}&token={config.MASTER_TOKEN}") as response:
                        if response.status == 200:
                            await ctx.send(f"Registered endpoint: https://api.astroid.cc/{endpoint}")
                        else:
                            await ctx.send(f"Oops, something went wrong: `{data['message']}`")
            except TypeError:
                async with aiohttp.ClientSession() as session: 
                    async with session.post(f"https://api.astroid.cc/createendpoint/nerimity?endpoint={endpoint}&id={ctx.server.id}&token={config.MASTER_TOKEN}") as response:
                        if response.status == 200:
                            await ctx.send(f"Registered endpoint: https://api.astroid.cc/{endpoint}")
                        else:
                            await ctx.send(f"Oops, something went wrong: `{data['message']}`")
            except Exception as e:
                await ctx.send(f"An error occurred while trying to register the endpoint. Please report this in the [Support Server](https://nerimity.com/i/fgE6q). \n\n`{e}`")

    try:
        channel_id = ctx.channel.id
        async with aiohttp.ClientSession() as session:
            async with session.post(f"https://api.astroid.cc/update/{endpoint}?channel_nerimity={channel_id}&token={config.MASTER_TOKEN}") as response:
                data = await response.json()
                if response.ok:
                    await ctx.send(f"Updated endpoint: https://api.astroid.cc/{endpoint}")
                else:
                    await ctx.send(f"Oops, something went wrong: `{data['message']}`")
    except Exception as e:
        await ctx.send(f"An error occurred while trying to update the endpoint. Please report this in the [Support Server](https://nerimity.com/i/fgE6q). \n\n`{e}`")
    


@client.command(aliases=["add-bridge"])
async def add_bridge(ctx: nerimity.Context, _args):
    async with aiohttp.ClientSession() as session:
        async with session.get(f"https://api.astroid.cc/getendpoint/nerimity?id={ctx.server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                endpoint = data["discord"]
                if not endpoint:
                    await ctx.respond(":x: - Your endpoint could not be found.")
                    return
            except:
                await ctx.respond(":x: - Your endpoint could not be found.")
                return
    if endpoint:
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"https://api.astroid.cc/update/{endpoint}?channel_nerimity={ctx.channel.id}&token={config.MASTER_TOKEN}")
        await ctx.respond(f"Updated endpoint: https://api.astroid.cc/{endpoint}")
    else:
        await ctx.respond(":x: - Your endpoint could not be found.")

@client.listen("on_ready")
async def on_ready(client_info: dict):
    print(f"Logged in as {client.account.username}#{client.account.tag}")
    asyncio.create_task(iamup_loop())

client.run()