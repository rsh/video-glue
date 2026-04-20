"""export_jobs_include_audio

Revision ID: 4664c957632b
Revises: a8366bafdaf5
Create Date: 2026-04-20 01:55:12.930572

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4664c957632b"
down_revision: Union[str, None] = "a8366bafdaf5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("export_jobs") as batch_op:
        batch_op.add_column(
            sa.Column(
                "include_audio",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("export_jobs") as batch_op:
        batch_op.drop_column("include_audio")
