import traceback
import revolt
from revolt.ext import commands
from dotenv import load_dotenv
import os
import pathlib
import json
import asyncio
import aiohttp
import sentry_sdk
import datetime
from apiclient import APIClient

load_dotenv()

# Initialize Sentry for error tracking
sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    traces_sample_rate=1.0,
    profiles_sample_rate=1.0,
)

prefix = "at!"

# Initialize API client
api_client = APIClient(os.getenv("API_URL"), os.getenv("MASTER_TOKEN"))

async def get_endpoint(server: revolt.Server):
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{os.getenv('API_URL')}/getendpoint/revolt?id={server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
                data = await response.json()
                return data["discord"]
    except:
        return False



async def send_iam_up():
    response = await api_client.post("monitor/iamup/revolt-beta")
    if response:
        print("Sent up status.")
    else:
        print("Could not send up status.")


class Client(commands.CommandsClient):
    async def get_prefix(self, message: revolt.Message):
        return prefix

    async def on_ready(self):
        asyncio.create_task(send_iam_up())
        print(f"Logged in as {self.user.name} ({self.user.id})")
            

    async def process_endpoint(self, endpoint_json, session, endpoint):
        content = endpoint_json["meta"]["message"]["content"]
        author_name = endpoint_json["meta"]["message"]["author"]["name"]
        author_avatar = endpoint_json["meta"]["message"]["author"]["avatar"]
        channel_ids_discord = endpoint_json["config"]["channels"]["discord"]
        channel_ids_guilded = endpoint_json["config"]["channels"]["guilded"]
        message_attachments = endpoint_json["meta"]["message"]["attachments"]
        sender_channel = endpoint_json["meta"]["sender-channel"]
        sender = endpoint_json["meta"]["sender"]

        if str(sender_channel) in map(str, channel_ids_guilded) or not channel_ids_guilded:
            channel_id = endpoint_json["config"]["channels"]["revolt"][channel_ids_guilded.index(str(sender_channel))]
        elif str(sender_channel) in map(str, channel_ids_discord):
            channel_id = endpoint_json["config"]["channels"]["revolt"][channel_ids_discord.index(str(sender_channel))]
        elif str(sender_channel) in map(str, endpoint_json["config"]["channels"]["nerimity"]):
            channel_id = endpoint_json["config"]["channels"]["revolt"][endpoint_json["config"]["channels"]["nerimity"].index(str(sender_channel))]

        channel = await self.fetch_channel(channel_id)
        color = self.get_sender_color(sender)

        await self.send_messages(channel, content, author_name, author_avatar, color, message_attachments)
        await session.post(
            f"{os.getenv('API_URL')}/read/{endpoint}?token={os.getenv('MASTER_TOKEN')}&read_revolt=true")

    async def send_messages(self, channel, content, author_name, author_avatar, color, message_attachments):
        if message_attachments:
            attachment_url = message_attachments[0].get('url', '')
            author_avatar_url = author_avatar if author_avatar else f"{os.getenv('API_URL')}/assets/Astroid_PFP_not_found.png"
            await channel.send(
                f"{content}\nAttachment: {attachment_url}\nAuthor Avatar: {author_avatar_url}"
            )
        else:
            await channel.send(content)

    def get_sender_color(self, sender):
        if sender == "discord":
            return "#5865F2"
        elif sender == "guilded":
            return "#fcd705"
        elif sender == "nerimity":
            return "#4c93ff"
        else:
            return "#fc0516"

    async def on_message(self, message: revolt.Message):
        if str(message.author.id) == str(self.user.id):
            return

        if message.content.lower().startswith(f"{prefix}help"):
            await self.send_help_message(message)
        else:
            await self.process_commands(message)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{os.getenv('API_URL')}/getendpoint/revolt?id={message.channel.server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
                    data = await response.json()
                    endpoint = data["discord"]
            async with aiohttp.ClientSession() as session:
                async with session.get(
                        f"{os.getenv('API_URL')}/{endpoint}?token={os.getenv('MASTER_TOKEN')}") as response:
                    endpoint_json = await response.json()
                    if message.channel.id in endpoint_json["config"]["channels"]["revolt"]:
                        await self.process_blacklist(message, session, endpoint, endpoint_json)
                        await self.process_allowed_ids(message, session, endpoint)
        except TypeError:
            pass
        except Exception:
            traceback.print_exc()

    async def send_help_message(self, message: revolt.Message):
        embed = revolt.SendableEmbed(
            title="astroid",
            description="API Docs: {os.getenv('API_URL')}/docs\n\n"
                        "**register** [discord_server_id]\n"
                        "Register your server.\nNote: First register your discord server, then the other platform.\n"
                        "**There is currently no command way to register without discord server. "
                        "If you want to register without discord server, [click here](https://rvlt.gg/KQ611eqF)**.\n\n"
                        "**set-log** [revolt_channel_id]\n"
                        "Setup your log channel.\n\n"
                        "**allow** [revolt_user_id]\n"
                        "Allow a bot or webhook to be forwarded.\n\n"
                        "**add-bridge**\n"
                        "Add another channel to bridge over.\n"
                        "Note: Works like `register`"
        )
        await message.reply(embed=embed)

    async def handle_message_content(self, message: revolt.Message, endpoint):
        async with aiohttp.ClientSession() as session:
            async with session.get(
                    f"{os.getenv('API_URL')}/{endpoint}?token={os.getenv('MASTER_TOKEN')}") as response:
                endpoint_json = await response.json()
                if message.channel.id in endpoint_json["config"]["channels"]["revolt"]:
                    await self.process_blacklist(message, session, endpoint, endpoint_json)
                    await self.process_allowed_ids(message, session, endpoint)

    async def process_blacklist(self, message, session, endpoint, endpoint_json):
        try:
            blacklist = endpoint_json["config"]["blacklist"]
            for word in blacklist:
                if word and word.lower() in message.content.lower():
                    embed = revolt.SendableEmbed(title=f"{message.author.name} - Flagged", description=message.content)
                    log_channel_id = endpoint_json["config"]["logs"]["revolt"]
                    channel = await self.fetch_channel(log_channel_id)
                    await channel.send(embed=embed)
                    return
        except Exception:
            traceback.print_exc()
    async def process_allowed_ids(self, message: revolt.Message, session, endpoint):
        print(message)
        await asyncio.sleep(2)
        try:
            message_still_exists = self.get_message(message.id)
            if not message_still_exists:
                print("Message does not exist")
                return
        except LookupError:
            return print("Message does not exist")
        except:
            traceback.print_exc()
        print("Message still exists")
        try:
            async with session.get(f"{os.getenv('API_URL')}/{endpoint}?token={os.getenv('MASTER_TOKEN')}") as response:
                allowed_ids = (await response.json())["config"]["allowed-ids"]
                print(message)
                if not str(message.author.id) == str(self.user.id):
                    if not message.attachments:
                        url = (
                            f"{os.getenv('API_URL')}/update/{endpoint}"
                            f"?message_content={message.content}"
                            f"&message_author_name={message.author.name}"
                            f"&message_author_avatar={message.author.avatar.url if message.author.avatar.url else '{os.getenv("API_URL")}/assets/Astroid PFP not found.png'}"
                            f"&message_author_id={message.author.id}"
                            f"&trigger=true&sender=revolt"
                            f"&token={os.getenv('MASTER_TOKEN')}&sender_channel={message.channel.id}"
                        )
                        async with session.post(url) as response:
                            print(f"Response status: {response.status}")
                            response_text = await response.text()
                            print(f"Response text: {response_text}")
                    elif len(message.attachments) >= 1:
                        attachments = ""
                        for attachment in message.attachments:
                            attachments += f"{attachment.url}/{attachment.filename},"
                        url = (
                            f"{os.getenv('API_URL')}/update/{endpoint}"
                            f"?message_content={'' if not message.content else message.content}"
                            f"&message_author_name={message.author.name}"
                            f"&message_author_avatar={message.author.avatar.url if message.author.avatar.url else '{os.getenv("API_URL")}/assets/Astroid PFP not found.png'}"
                            f"&message_author_id={message.author.id}"
                            f"&message_attachments={attachments}"
                            f"&trigger=true&sender=revolt"
                            f"&token={os.getenv('MASTER_TOKEN')}&sender_channel={message.channel.id}"
                        )
                        async with session.post(url) as response:
                            print(f"Response status: {response.status}")
                            response_text = await response.text()
                            print(f"Response text: {response_text}")

        except aiohttp.ClientError as e:
            print(f"Request failed: {e}")

    @commands.command()
    async def register(self, ctx: commands.Context, endpoint=None):  
        if endpoint == "":
            await ctx.send("Invalid Format: `a!register DISCORD_SERVER_ID`")
        else:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{os.getenv('API_URL')}/getendpoint/revolt?id={ctx.message.channel.server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
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
                            async with session.post(f"{os.getenv('API_URL')}/createendpoint/revolt?endpoint={endpoint}&id={ctx.message.channel.server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
                                if response.ok:
                                    await ctx.send(f"Registered endpoint: {os.getenv('API_URL')}/{endpoint}")
                                else:
                                    traceback.print_exc()
                                    await ctx.send(f"Oops, something went wrong: `{await response.text()}`")
                    except IndexError:
                        async with aiohttp.ClientSession() as session: 
                            async with session.post(f"{os.getenv('API_URL')}/createendpoint/revolt?endpoint={endpoint}&id={ctx.message.channel.server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
                                if response.ok:
                                    await ctx.send(f"Registered endpoint: {os.getenv('API_URL')}/{endpoint}")
                                else:
                                    traceback.print_exc()
                                    await ctx.send(f"Oops, something went wrong: `{await response.text()}`")
                    except TypeError:
                        async with aiohttp.ClientSession() as session: 
                            async with session.post(f"{os.getenv('API_URL')}/createendpoint/revolt?endpoint={endpoint}&id={ctx.message.channel.server.id}&token={os.getenv('MASTER_TOKEN')}") as response:
                                if response.ok:
                                    await ctx.send(f"Registered endpoint: {os.getenv('API_URL')}/{endpoint}")
                                else:
                                    traceback.print_exc()
                                    await ctx.send(f"Oops, something went wrong: `{await response.text()}`")
                    except Exception as e:
                        traceback.print_exc()
                        await ctx.send(f"An error occurred while trying to register the endpoint. Please report this in the [Support Server](https://rvlt.gg/KQ611eqF). \n\n`{e}`")
            try:
                channel_id = ctx.channel.id
                async with aiohttp.ClientSession() as session:
                    async with session.post(f"{os.getenv('API_URL')}/update/{endpoint}?channel_revolt={channel_id}&token={os.getenv('MASTER_TOKEN')}") as response:
                        data = await response.json()
                        print(response.text)
                        if response.ok:
                            await ctx.send(f"Updated endpoint: {os.getenv('API_URL')}/{endpoint}")
                        else:
                            traceback.print_exc()
                            await ctx.send(f"Oops, something went wrong: `{await response.text()}`")
            except Exception as e:
                traceback.print_exc()
                await ctx.send(f"An error occurred while trying to update the endpoint. Please report this in the [Support Server](https://rvlt.gg/KQ611eqF). \n\n`{e}`")

    @commands.command()
    async def allow(self, ctx, allowid: str = None):
        if allowid is None:
            await ctx.message.reply("Missing parameter: `allow_id`.\n Usage: `a!allow [allow_id]`")
            return
        endpoint = await get_endpoint(ctx.server)
        if endpoint:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{os.getenv('API_URL')}/update/{endpoint}?allowed_ids={allowid}&token={os.getenv('MASTER_TOKEN')}")
            await ctx.message.reply(f"Updated endpoint: {os.getenv('API_URL')}/{endpoint}")
        else:
            await ctx.message.reply(":x: - Your endpoint could not be found.")

    @commands.command()
    async def set_logs(self, ctx, channel: str = None):
        if channel is None:
            await ctx.message.reply("Missing parameter: `channel_id`.\n Usage: `a!set_logs [channel_id]`")
            return
        endpoint = await get_endpoint(ctx.server)
        if endpoint:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{os.getenv('API_URL')}/update/{endpoint}?log_revolt={channel}&token={os.getenv('MASTER_TOKEN')}")
            await ctx.message.reply(f"Updated endpoint: {os.getenv('API_URL')}/{endpoint}")
        else:
            await ctx.message.reply(":x: - Your endpoint could not be found.")

    @commands.command(aliases=["add-bridge"])
    async def add_bridge(self, ctx):
        endpoint = await get_endpoint(ctx.server)
        if endpoint:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{os.getenv('API_URL')}/update/{endpoint}?channel_revolt={ctx.channel.id}&token={os.getenv('MASTER_TOKEN')}")
            await ctx.message.reply(f"Updated endpoint: {os.getenv('API_URL')}/{endpoint}")
        else:
            await ctx.message.reply(":x: - Your endpoint could not be found.")

async def main():
    async with aiohttp.ClientSession() as session:
        client = Client(session, os.getenv("REVOLT_TOKEN"))
        await client.start()

asyncio.run(main())