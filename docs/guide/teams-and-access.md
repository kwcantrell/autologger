---
title: Teams and access
section: guide
order: 90
description: Teams, roles, show access, invites, instance admins, and what agents and Companion devices can do.
---

# Teams and access

Teams hold shows, and shows hold sessions. Your role in a team, and your access to each show,
decide what you can see and change. Agents and Companion devices act as the person who connected
them, never with more access.

## Roles

| Role   | Can do                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Owner  | Everything an admin can, plus change roles, transfer ownership and delete the team. One per team.                              |
| Admin  | Open every show; add, edit and delete shows; set event buttons; invite and remove members; grant shows; add Companion devices. |
| Member | Open only the shows they have been given, with Read or Write access.                                                           |

Owners and admins can open every show of the team.

## Show access

Members get access show by show:

| Access    | Can do                                                       |
| --------- | ------------------------------------------------------------ |
| No access | Doesn't see the show.                                        |
| Read      | Open sessions, transcripts, topics, dashboards and the wiki. |
| Write     | Also log events, record and import audio, and edit content.  |

Set it per member in **Settings › Members** (open a member, then **Show access**), or per show in
**Settings › Shows** (edit the show, then **Who can open it**).

## Invite someone

In **Settings › Members › Invite someone**, enter their **Email address**, choose **Member** or
**Admin**, and **Send invite**. They join when they first sign in with that email, or right away if
they already have an account. Choose their shows afterwards. An invite that hasn't been used yet
can be revoked from the members list.

## Change or remove a member

Open a member in **Settings › Members**:

- **Role**: only the owner changes roles between Admin and Member.
- **Show access**: for members, per show.
- **Remove from team**: they lose access right away, including to any open sessions. The owner can
  remove anyone; admins can remove members.

## Hand over or leave a team

**Settings › Team details** has the team name and, at the bottom:

- **Transfer ownership** (owner): make someone else the owner; you become an admin.
- **Delete team** (owner): permanently deletes the team with its shows and sessions.
- **Leave team** (everyone but the owner): you lose access to its shows and sessions. The owner
  transfers ownership first.

You can be on several teams; switch between them with the team name in the top bar.

## Approve new accounts

Instance admins look after the whole AutoLogger server in **Settings › Users**. New accounts wait
there until approved, unless they were invited to a team. Instance admins can **Approve**,
**Disable** (signs the person out everywhere and revokes their agent tokens) and **Re-enable**
accounts, and make others instance admins.

The first account on a new server becomes its instance admin; see
[Self-hosting](/docs/developers/self-hosting) for setting admins in the server's configuration.

## Agents

Agents connected over MCP act as you: they can read and change every show you can, and nothing
more. Accounts still waiting for approval can't connect agents. Manage them in **Settings ›
Agents**; see [Connecting agents](/docs/agents/connecting-agents).

## Companion devices

A Companion device is a token that lets a Stream Deck log in one show. Owners and admins create
them in **Settings › Companion devices**. A device acts as the person who created it, limited to its
one show and never above write access; if that person loses access, the device stops working. See
[Companion](/docs/guide/companion).

## Related

- [Getting started](/docs/guide/getting-started)
- [Changes and undo](/docs/guide/changes-and-undo)
