import json
import os
import guilded
from guilded.ext import commands
import config
import aiohttp
import pathlib
import datetime
import traceback
import sentry_sdk
import asyncio
from apiclient import APIClient
from dotenv import load_dotenv

load_dotenv()

sentry_sdk.init(
    dsn=config.SENTRY_DSN,
    # Set traces_sample_rate to 1.0 to capture 100%
    # of transactions for performance monitoring.
    traces_sample_rate=1.0,
    # Set profiles_sample_rate to 1.0 to profile 100%
    # of sampled transactions.
    # We recommend adjusting this value in production.
    profiles_sample_rate=1.0,
) 

client = commands.Bot(command_prefix="ab!")


client.help_command = None

API_URL = os.getenv("API_URL")
# Initialize API client
api_client = APIClient(API_URL, config.MASTER_TOKEN)


async def send_iamup():
    response = await api_client.post("monitor/iamup/guilded-beta")
    if response:
        print("Sent up status.")
    else:
        print("Could not send up status.")


async def iamup_loop():
    while True:
        asyncio.create_task(send_iamup())
        await asyncio.sleep(40)

async def activity_task():
    while True:
        await client.remove_status()
        print("Updating activity..")
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{API_URL}/statistics") as r:
                data = await r.json()
                emote = guilded.utils.get(client.servers, id="ME2BprdE").get_emote(2414758)
                await client.set_status(emote=emote, content=f'{data["messages"]["total_rounded"]}+ messages | {data["endpoints"]} servers')
                print("Updated activity.")
        await asyncio.sleep(120)


@client.event
async def on_ready():
    print("Bot is ready.")
    client.loop.create_task(iamup_loop())
    client.loop.create_task(activity_task())




@client.event
async def on_message_delete(message: guilded.Message):
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API_URL}/getendpoint/guilded?id={message.server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                endpoint = data["discord"]
                if not endpoint:
                    return
            except:
                return

    channels_url = (
        f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}"
    )
    channels_data = await api_client.get(channels_url)

    if message.channel.id in channels_data["config"]["channels"]["guilded"]:
        embed = guilded.Embed(
            title=f"{message.author.name} - Deleted",
            description=message.content,
            colour=0xF5C400,
        )
        embed.add_field(
            name="Created at",
            value=f'{datetime.datetime.strftime(message.created_at, "%Y-%m-%d %H:%M.%S")} UTC',
        )

        logs_url = (
            f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}"
        )
        logs_data = await api_client.get(logs_url)

        channel = await client.fetch_channel(logs_data["config"]["logs"]["guilded"])
        await channel.send(embed=embed)


@client.event
async def on_message_edit(before: guilded.Message, after: guilded.Message):
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API_URL}/getendpoint/guilded?id={before.server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                endpoint = data["discord"]
                if not endpoint:
                    return
            except:
                return

    channels_url = (
        f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}"
    )
    channels_data = await api_client.get(channels_url)

    if before.channel.id in channels_data["config"]["channels"]["guilded"]:
        embed = guilded.Embed(
            title=f"{before.author.name} - Edited",
            description=after.content,
            colour=0xF5C400,
        )
        embed.add_field(name="Jump", value=f"[Jump]({after.jump_url})")
        embed.add_field(name="Before", value=before.content, inline=False)
        embed.add_field(name="After", value=after.content, inline=False)

        logs_url = (
            f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}"
        )
        logs_data = await api_client.get(logs_url)

        channel = await client.fetch_channel(logs_data["config"]["logs"]["guilded"])
        await channel.send(embed=embed)


@client.command()
async def register(ctx: commands.Context, endpoint):
    if ctx.author.guild_permissions.administrator:
        if endpoint == "":
            await ctx.send("Invalid Format: `a!register DISCORD_SERVER_ID`")
        else:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{API_URL}/getendpoint/guilded?id={ctx.message.server_id}&token={config.MASTER_TOKEN}") as response:
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
                            async with session.post(f"{API_URL}/createendpoint/guilded?endpoint={endpoint}&id={ctx.message.server_id}&token={config.MASTER_TOKEN}") as response:
                                if response.status == 200:
                                    await ctx.send(f"Registered endpoint: {API_URL}/{endpoint}")
                                else:
                                    await ctx.send(f"Oops, something went wrong: `{data['message']}`")
                    except IndexError:
                        async with aiohttp.ClientSession() as session: 
                            async with session.post(f"{API_URL}/createendpoint/guilded?endpoint={endpoint}&id={ctx.message.server_id}&token={config.MASTER_TOKEN}") as response:
                                if response.status == 200:
                                    await ctx.send(f"Registered endpoint: {API_URL}/{endpoint}")
                                else:
                                    await ctx.send(f"Oops, something went wrong: `{data['message']}`")
                    except TypeError:
                        async with aiohttp.ClientSession() as session: 
                            async with session.post(f"{API_URL}/createendpoint/guilded?endpoint={endpoint}&id={ctx.message.server_id}&token={config.MASTER_TOKEN}") as response:
                                if response.status == 200:
                                    await ctx.send(f"Registered endpoint: {API_URL}/{endpoint}")
                                else:
                                    await ctx.send(f"Oops, something went wrong: `{data['message']}`")
                    except Exception as e:
                        await ctx.send(f"An error occurred while trying to register the endpoint. Please report this in the [Support Server](https://guilded.gg/astroid). \n\n`{e}`")

        try:
            channel_id = ctx.channel.id
            channel_webhook = await ctx.channel.create_webhook(name="astroid")
            channel_webhook_url = channel_webhook.url
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{API_URL}/update/{endpoint}?channel_guilded={channel_id}&webhook_guilded={channel_webhook_url}&token={config.MASTER_TOKEN}") as response:
                    data = await response.json()
                    if response.ok:
                        await ctx.send(f"Updated endpoint: {API_URL}/{endpoint}")
                    else:
                        await ctx.send(f"Oops, something went wrong: `{data['message']}`")
        except Exception as e:
            await ctx.send(f"An error occurred while trying to update the endpoint. Please report this in the [Support Server](https://guilded.gg/astroid). \n\n`{e}`")
    else:
        await ctx.send("You must be an administrator to use this command.")


@client.command()
async def help(ctx):
    embed = guilded.Embed(
        title="astroid", description="API Docs: {API_URL}/docs"
    )
    embed.add_field(
        name="register",
        value="Register your server.\nNote: First register your discord server, then guilded.",
        inline=False,
    )
    embed.add_field(
        name="set-log",
        value="Setup your log channel.\nUsage: DISCORD_SERVER_ID GUILDED_CHANNEL_ID",
        inline=False,
    )
    embed.add_field(
        name="allow",
        value="Allow a bot or webhook to be forwarded.\nUsage: DISCORD_SERVER_ID USER_ID",
        inline=False,
    )
    embed.add_field(
        name="add-bridge",
        value="Add another channel to bridge over.\nNote: Works like `register`",
        inline=False,
    )
    await ctx.send(embed=embed)


@client.command()
async def set_log(ctx, endpoint, channelid):
    if endpoint == "" or channelid == "":
        await ctx.send(
            "Invalid Format: `a!set-log DISCORD_SERVER_ID GUILDED_CHANNEL_ID`"
        )
    else:
        r = await api_client.post(
            f"{API_URL}/update/{endpoint}?channel_guilded={ctx.channel.id}&log_guilded={channelid}&token={config.MASTER_TOKEN}",
            {},
        )
        if r.ok:
            await ctx.send(
                f"Updated endpoint: {API_URL}/{endpoint}"
            )
        else:
            await ctx.send(f"{r['message']}")


@client.command()
async def allow(ctx, endpoint, allowid):
    if ctx.author.guild_permissions.administrator:
        if endpoint == "" or allowid == "":
            await ctx.send("Invalid Format: `a!allow DISCORD_SERVER_ID GUILDED_USER_ID`")
        else:
            r = await api_client.post(
                f"{API_URL}/update/{endpoint}?allowed_ids={allowid}&token={config.MASTER_TOKEN}",
                {},
            )
            if r.ok:
                await ctx.send(
                    f"Updated endpoint: {API_URL}/{endpoint}"
                )
            else:
                await ctx.send(f"{r['message']}")
    else:
        await ctx.send("You must be an administrator to use this command.")



@client.command(aliases=["add-bridge"])
async def add_bridge(ctx, endpoint):
    if ctx.author.guild_permissions.administrator:
        if endpoint == "":
            await ctx.send("Invalid Format: `a!add-bridge DISCORD_SERVER_ID`")
        else:
            webhook = await ctx.channel.create_webhook(name="astroid")
            r = await api_client.post(
                f"{API_URL}/update/{endpoint}?channel_guilded={ctx.channel.id}&webhook_guilded={webhook.url}&token={config.MASTER_TOKEN}",
                {},
            )
            if r.ok:
                await ctx.send(
                    f"Updated endpoint: {API_URL}/{endpoint}"
                )
            else:
                await ctx.send(f"{r['message']}")
    else:
        await ctx.send("You must be an administrator to use this command.")


@client.command()
async def send_embed(ctx):
    embed = guilded.Embed(title="Test Title", description="Test Description")
    embed.add_field(name="Test Field", value="Test Field Value")
    embed.set_image(url="https://media1.tenor.com/m/YYPY5tPFIE8AAAAd/bad-teeth.gif")
    embed.set_thumbnail(
        url="https://media.pinatafarm.com/protected/B183D0EF-49B8-47BF-A523-E72FD0CFFAAC/Soyjak-Pointing.2.meme.webp"
    )
    await ctx.send("Test Message", embed=embed)


@client.event
async def on_message(message: guilded.Message):
    await client.process_commands(message)
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API_URL}/getendpoint/guilded?id={message.server.id}&token={config.MASTER_TOKEN}") as response:
            data = await response.json()
            try:
                endpoint = data["discord"]
                if not endpoint:
                    return
            except:
                return
            async with session.get(f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}") as isbeta:
                isbeta = await isbeta.json()
                if not isbeta.get("config").get("isbeta"):
                    return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{API_URL}/getendpoint/guilded?id={message.server.id}&token={config.MASTER_TOKEN}") as response:
                data = await response.json()
                endpoint = data["discord"]

        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{API_URL}/{endpoint}?token={config.MASTER_TOKEN}"
            ) as response:
                data = await response.json()
                if message.channel.id in data["config"]["channels"]["guilded"]:
                    blacklist = data["config"]["blacklist"]
                    for word in blacklist:
                        if word is not None and word.lower() in message.content.lower():
                            embed = guilded.Embed(
                                title=f"{message.author.name} - Flagged",
                                description=message.content,
                                colour=0xF5C400,
                            )
                            await message.delete()
                            channel = await client.fetch_channel(
                                str(data["config"]["logs"]["guilded"])
                            ).close()
                            await channel.send(embed=embed)
                            return
                    allowed_ids = data["config"]["allowed-ids"]
                    if not message.author.bot or message.author.id in allowed_ids:
                        # Build unified payload for the new API: POST /:id/messages with JSON body
                        author_avatar = None
                        try:
                            author_avatar = message.author.avatar.url if getattr(message.author, 'avatar', None) and getattr(message.author.avatar, 'url', None) else None
                        except Exception:
                            author_avatar = None

                        payload = {
                            "content": message.content,
                            "author": {
                                "name": message.author.name,
                                "avatar": author_avatar or f"{API_URL}/assets/Astroid PFP not found.png",
                                "id": str(message.author.id),
                            },
                            "sender": "guilded",
                            "sender-channel": str(message.channel.id),
                        }

                        # Reply handling
                        if getattr(message, 'replied_to', None) and len(message.replied_to) > 0:
                            try:
                                payload["isReply"] = True
                                payload["reply"] = {
                                    "message": message.replied_to[0].content,
                                    "author": getattr(message.replied_to[0].author, 'name', None),
                                }
                            except Exception:
                                payload["isReply"] = True
                                payload["reply"] = {"message": None, "author": None}
                        else:
                            payload["isReply"] = False

                        # Embed handling (first embed only, if present)
                        if message.embeds:
                            try:
                                e = message.embeds[0]
                                embed_obj = {
                                    "title": getattr(e, 'title', None),
                                    "description": getattr(e, 'description', None),
                                    "thumbnail": getattr(getattr(e, 'thumbnail', None), 'url', None),
                                    "image": getattr(getattr(e, 'image', None), 'url', None),
                                    "footer": getattr(getattr(e, 'footer', None), 'text', None),
                                    "fields": [],
                                }
                                if getattr(e, 'fields', None):
                                    for field in e.fields:
                                        embed_obj["fields"].append(
                                            {
                                                "name": getattr(field, 'name', None),
                                                "value": getattr(field, 'value', None),
                                                "inline": bool(getattr(field, 'inline', False)),
                                            }
                                        )
                                payload["embed"] = embed_obj
                            except Exception:
                                pass

                        # Attachments handling (array of URLs)
                        if message.attachments:
                            try:
                                payload["attachments"] = [str(att.url) for att in message.attachments]
                            except Exception:
                                payload["attachments"] = []

                        # Send to new API endpoint
                        async with session.post(
                            f"{API_URL}/{endpoint}/messages?token={config.MASTER_TOKEN}",
                            json=payload,
                        ) as response:
                            # Optionally check response status
                            _ = response.status
    except FileNotFoundError:
        pass
    except KeyError:
        pass
    except:
        traceback.print_exc()


client.run(config.GUILDED_TOKEN)
